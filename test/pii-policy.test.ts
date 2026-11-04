import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// T7.9: severity rules and expiring suppressions of a target profile, applied to PII findings. No browser.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-pii-policy-test-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com';

const { applyPiiPolicy, policyProblems, MAX_SUPPRESSION_DAYS } = await import('../src/security/piiPolicy.js');
const { piiPolicySchema } = await import('../src/schemas/piiPolicy.schema.js');
const { FindingCollector } = await import('../src/security/piiFindings.js');
const { saveTarget, getTarget, PiiPolicyError } = await import('../src/targets/targetStore.js');
const { targetProfileSchema } = await import('../src/schemas/targetProfile.schema.js');

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const key = Buffer.alloc(32, 3);
function findings() {
  const collector = new FindingCollector({ key });
  collector.add('email', 'response-body', 'GET https://dev.example.com/perfil (response, no credentials sent)', 'maria@example.com');
  collector.add('email', 'response-body', 'GET https://dev.example.com/contato (response, no credentials sent)', 'info@example.com');
  collector.add('jwt', 'url', 'GET https://dev.example.com/cb [fragment:id_token]', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop');
  collector.add('secret-named', 'storage', 'localStorage["access_token"]', 'opaque-token-value');
  return collector.findings();
}
const policy = (input: unknown) => piiPolicySchema.parse(input);
const NOW = new Date('2026-11-04T12:00:00Z');

test('without a policy nothing changes', () => {
  const all = findings();
  assert.deepEqual(applyPiiPolicy(all, undefined, NOW), { findings: all, suppressed: [], expired: [] });
  assert.deepEqual(applyPiiPolicy(all, policy({}), NOW).findings, all);
});

test('a severity rule re-rates a kind of finding, says why, and the most specific rule wins (later among equals)', () => {
  const result = applyPiiPolicy(
    findings(),
    policy({
      severity: [
        { surface: 'response-body', severity: 'info' },
        { detector: 'email', surface: 'response-body', severity: 'medium', note: 'public page of this app' },
        { detector: 'secret-named', severity: 'low' },
        { detector: 'secret-named', severity: 'high' },
      ],
    }),
    NOW,
  );
  const email = result.findings.filter((f) => f.detector === 'email');
  assert.deepEqual(email.map((f) => f.severity), ['medium', 'medium'], 'detector+surface beats surface alone');
  assert.equal(email[0]?.severityReason, 'profile policy: low -> medium (public page of this app)');
  const token = result.findings.find((f) => f.detector === 'secret-named')!;
  assert.equal(token.severity, 'high', 'the later of two equally specific rules');
  assert.equal(result.findings.find((f) => f.detector === 'jwt')?.severityReason, undefined, 'untouched findings carry no reason');
  assert.equal(result.findings[0]?.severity, 'high', 'order follows the new severity');
});

test('a suppression moves the finding out of the list, keeps it visible with its reason, and matches by detector, surface and location', () => {
  const result = applyPiiPolicy(
    findings(),
    policy({ suppressions: [{ id: 'profile-email', detector: 'email', surface: 'response-body', locationContains: '/perfil', reason: 'the logged-in user sees their own e-mail here', until: '2026-12-31' }] }),
    NOW,
  );
  assert.equal(result.findings.length, 3);
  assert.equal(result.suppressed.length, 1);
  assert.deepEqual(result.suppressed[0], {
    detector: 'email',
    surface: 'response-body',
    location: 'GET https://dev.example.com/perfil (response, no credentials sent)',
    suppression: 'profile-email',
    reason: 'the logged-in user sees their own e-mail here',
    until: '2026-12-31',
  });
  assert.ok(result.findings.some((f) => f.location.includes('/contato')), 'another e-mail on another page still counts');
});

test('a suppression applies through its last day and no longer after; the lapse is reported', () => {
  const rule = policy({ suppressions: [{ id: 's1', detector: 'email', reason: 'expected on the public pages', until: '2026-11-04' }] });
  assert.equal(applyPiiPolicy(findings(), rule, new Date('2026-11-04T23:59:59Z')).suppressed.length, 2, 'the day itself still counts as covered');
  const later = applyPiiPolicy(findings(), rule, new Date('2026-11-05T00:00:00Z'));
  assert.equal(later.suppressed.length, 0);
  assert.equal(later.findings.filter((f) => f.detector === 'email').length, 2, 'the findings count again');
  assert.deepEqual(later.expired, [{ id: 's1', until: '2026-11-04' }]);
});

test('severity is decided first, so a suppression can target the re-rated finding too', () => {
  const result = applyPiiPolicy(findings(), policy({ severity: [{ detector: 'email', severity: 'info' }], suppressions: [{ id: 's', detector: 'email', reason: 'all of these are expected', until: '2027-01-01' }] }), NOW);
  assert.equal(result.suppressed.length, 2);
});

test('the schema refuses what would make a policy a blind spot', () => {
  const ok = { id: 's', detector: 'email', reason: 'a reason long enough', until: '2027-01-01' };
  assert.ok(piiPolicySchema.safeParse({ suppressions: [ok] }).success);
  assert.ok(!piiPolicySchema.safeParse({ suppressions: [{ ...ok, detector: undefined }] }).success, 'no "suppress everything"');
  assert.ok(!piiPolicySchema.safeParse({ suppressions: [{ ...ok, reason: 'ok' }] }).success, 'a reason is required');
  assert.ok(!piiPolicySchema.safeParse({ suppressions: [{ ...ok, until: undefined }] }).success, 'an expiry is required');
  assert.ok(!piiPolicySchema.safeParse({ suppressions: [{ ...ok, until: '2027-02-30' }] }).success, 'not a real date');
  assert.ok(!piiPolicySchema.safeParse({ suppressions: [{ ...ok, until: '01/01/2027' }] }).success);
  assert.ok(!piiPolicySchema.safeParse({ suppressions: [{ ...ok, detector: 'known-secret' }] }).success, 'a vault value on a page cannot be suppressed');
  assert.ok(!piiPolicySchema.safeParse({ severity: [{ detector: 'known-secret', severity: 'info' }] }).success, 'nor re-rated');
  assert.ok(!piiPolicySchema.safeParse({ severity: [{ severity: 'info' }] }).success, 'a rule for everything is refused');
  assert.ok(!piiPolicySchema.safeParse({ suppressions: [ok, ok] }).success, 'duplicate id');
  assert.ok(!piiPolicySchema.safeParse({ suppressions: [{ ...ok, regex: '.*' }] }).success);
});

test('policyProblems: in the past, or further ahead than a year', () => {
  const at = (until: string) => policyProblems(policy({ suppressions: [{ id: 's', detector: 'email', reason: 'a reason long enough', until }] }), NOW);
  assert.deepEqual(at('2026-11-04'), []);
  assert.deepEqual(at('2027-11-05'), []);
  assert.match(at('2026-11-03')[0]!.message, /in the past/);
  assert.match(at('2028-01-01')[0]!.message, new RegExp(`at most ${MAX_SUPPRESSION_DAYS} days`));
});

test('a target profile stores the policy; an expired or far-off suppression is refused at save; a stored one that later expires still loads', async () => {
  const base = {
    id: 'shop', name: 'Shop', platform: 'generic', environment: 'qa', baseUrl: 'https://dev.example.com/', credentialSets: [], noiseFilters: [], surfaces: {}, screens: [],
    flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  };
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const saved = await saveTarget(targetProfileSchema.parse({ ...base, pii: { suppressions: [{ id: 'p', detector: 'email', reason: 'expected on the profile screen', until: tomorrow }] } }));
  assert.equal(saved.pii?.suppressions[0]?.id, 'p');
  assert.equal((await getTarget('shop'))?.pii?.suppressions[0]?.until, tomorrow);

  await assert.rejects(() => saveTarget(targetProfileSchema.parse({ ...base, pii: { suppressions: [{ id: 'p', detector: 'email', reason: 'expected on the profile screen', until: '2020-01-01' }] } })), PiiPolicyError);
  await assert.rejects(() => saveTarget(targetProfileSchema.parse({ ...base, pii: { suppressions: [{ id: 'p', detector: 'email', reason: 'expected on the profile screen', until: '2099-01-01' }] } })), /at most 366 days/);

  // A profile written when its suppression was valid keeps loading after the date passes (the clock is not in the schema).
  const file = path.join(dataDir, 'targets', 'shop.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  stored.pii.suppressions[0].until = '2020-01-01';
  fs.writeFileSync(file, JSON.stringify(stored));
  assert.equal((await getTarget('shop'))?.pii?.suppressions[0]?.until, '2020-01-01');
});
