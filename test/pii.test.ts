import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// T7.8: the PII detectors, masking, fingerprints, collection and the schema of the step. No browser.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-pii-test-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com';

const { fingerprintOf, isSecretName, isSessionCookieName, maskSpans, maskValue, scanText, scanUrl } = await import('../src/security/piiDetectors.js');
const { countFindings, defaultSeverity, FindingCollector, meetsFailLevel } = await import('../src/security/piiFindings.js');
const { getPiiFingerprintKey } = await import('../src/security/piiSalt.js');
const { isValidDocument } = await import('../src/generators/generators.js');
const { explorationRequestSchema } = await import('../src/schemas/explorationRequest.schema.js');
const { piiReportSchema } = await import('../src/schemas/pii.schema.js');
const { usesPiiScan } = await import('../src/runner/piiScanner.js');

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

// Valid documents (check digits verified below, so a typo here fails loudly instead of weakening a test).
const CPF = '529.982.247-25';
const CNPJ = '11.222.333/0001-81';
const CARD = '4111 1111 1111 1111';
const CI = '1.234.567-2';
function findRut(): string {
  for (let n = 100000; n < 999999; n += 1) {
    const candidate = `21${String(n).padStart(6, '0')}0010`.slice(0, 11);
    for (let d = 0; d <= 9; d += 1) if (isValidDocument('rut-uy', `${candidate}${d}`)) return `${candidate}${d}`;
  }
  throw new Error('no RUT found');
}
const RUT = findRut();
const key = Buffer.alloc(32, 7);

test('the sample documents really are valid (the tests below rest on it)', () => {
  assert.ok(isValidDocument('cpf', CPF));
  assert.ok(isValidDocument('cnpj', CNPJ));
  assert.ok(isValidDocument('ci-uy', '12345672'));
  assert.ok(isValidDocument('rut-uy', RUT));
});

const kinds = (text: string, knownSecrets: string[] = []) => scanText(text, { knownSecrets }).map((match) => match.detector);

test('each detector finds its document, with or without separators, and only with a correct check digit', () => {
  assert.deepEqual(kinds(`CPF: ${CPF}`), ['cpf']);
  assert.deepEqual(kinds(`CPF ${CPF.replace(/\D/g, '')}`), ['cpf']);
  assert.deepEqual(kinds(`CNPJ ${CNPJ}`), ['cnpj']);
  assert.deepEqual(kinds(`CI ${CI}`), ['ci-uy']);
  assert.deepEqual(kinds(`RUT ${RUT}`), ['rut-uy']);
  assert.deepEqual(kinds(`cartao ${CARD}`), ['card']);
  assert.deepEqual(kinds('wrong check digit 529.982.247-26'), []);
  assert.deepEqual(kinds('1.234.567-3'), []);
  assert.deepEqual(kinds('4111 1111 1111 1112'), []);
});

test('numbers that are not documents stay quiet: timestamps, ids, versions, repeated digits', () => {
  assert.deepEqual(kinds('ts=1730000000000 id=00012345678 build 2026.11.04 111.111.111-11 0000000000000'), []);
  assert.deepEqual(kinds('order 123456789012345'), []);
});

test('a CNPJ is not also reported as a CPF, and one match is reported once', () => {
  const found = scanText(`${CNPJ} and ${CPF}`);
  assert.deepEqual(found.map((match) => match.detector).sort(), ['cnpj', 'cpf']);
});

test('e-mail, phone of Uruguay, JWT, bearer and API-key shapes', () => {
  assert.deepEqual(kinds('write to maria.perez@example.com.uy now'), ['email']);
  assert.deepEqual(kinds('logo@2x.png and icon@3x.svg'), []);
  assert.deepEqual(kinds('call +598 99 123 456 or 099 123 456 or 00598 2123 4567'),['phone-uy', 'phone-uy', 'phone-uy']);
  assert.deepEqual(kinds('12345678'), []);
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop';
  assert.deepEqual(kinds(`token=${jwt}`), ['jwt']);
  assert.deepEqual(kinds('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345'), ['bearer']);
  assert.deepEqual(kinds('key sk-abcdefghijklmnopqrstuvwxyz0123'), ['api-key']);
  assert.deepEqual(kinds('AKIAABCDEFGHIJKLMNOP'), ['api-key']);
});

test('a known secret is found anywhere when long enough, or when it is the whole text', () => {
  assert.deepEqual(kinds('the password is Tr0ub4dor&3 ok', ['Tr0ub4dor&3']), ['known-secret']);
  assert.deepEqual(kinds('abc', ['abc']), ['known-secret']);
  assert.deepEqual(kinds('an abc inside text', ['abc']), [], 'a short value would match innocently inside longer text');
});

test('masking shows the shape and never the value', () => {
  assert.equal(maskValue('cpf', CPF), '***.***.***-25');
  assert.equal(maskValue('card', CARD), '**** **** **** **11');
  assert.equal(maskValue('email', 'maria.perez@example.com.uy'), 'm***@e***.uy');
  assert.equal(maskValue('known-secret', 'Tr0ub4dor&3'), '*** (11 chars)');
  assert.match(maskValue('jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop'), /^eyJ\*\*\* \(\d+ chars\)$/);
  const text = `a ${CPF} b maria@example.com`;
  assert.equal(maskSpans(text, scanText(text)), 'a ***.***.***-25 b m***@e***.com');
});

test('the fingerprint is keyed: stable for one value however it is written, different under another key, and not a plain sha256', async () => {
  const { createHash } = await import('node:crypto');
  const a = fingerprintOf('cpf', CPF, key);
  assert.equal(a, fingerprintOf('cpf', CPF.replace(/\D/g, ''), key), 'separators do not change it');
  assert.equal(fingerprintOf('email', 'Maria@Example.com', key), fingerprintOf('email', 'maria@example.com', key));
  assert.notEqual(a, fingerprintOf('cpf', CPF, Buffer.alloc(32, 8)));
  assert.notEqual(a, createHash('sha256').update(CPF.replace(/\D/g, '')).digest('hex'), 'a plain sha256 of an 11-digit document can be reversed by trying them all');
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('the installation key is created once, 32 bytes, and read back', async () => {
  const first = await getPiiFingerprintKey();
  assert.equal(first.length, 32);
  assert.deepEqual(await getPiiFingerprintKey(), first);
  assert.equal(fs.readFileSync(path.join(dataDir, 'pii-fingerprint.key'), 'utf8').trim().length, 64);
});

test('a URL is reduced to origin, masked path and parameter NAMES; the values never survive', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop';
  const scan = scanUrl(`https://dev.example.com/clientes/${CPF.replace(/\D/g, '')}/ficha?access_token=opaque-token-value&email=maria%40example.com&q=ok#id_token=${jwt}`);
  const found = scan.hits.map((hit) => `${hit.detector}@${hit.where}`).sort();
  assert.deepEqual(found, ['cpf@path', 'email@query:email', 'jwt@fragment:id_token', 'secret-named@query:access_token']);
  assert.equal(scan.display, 'https://dev.example.com/clientes/*********25/ficha?access_token,email,q#id_token');
  for (const secret of [CPF.replace(/\D/g, ''), 'opaque-token-value', 'maria', jwt]) assert.ok(!scan.display.includes(secret), `display leaks ${secret.slice(0, 6)}`);
});

test('a session id in the path (;jsessionid=) and an OAuth fragment are found', () => {
  assert.deepEqual(scanUrl('https://dev.example.com/app;jsessionid=ABCDEF1234567890/home').hits.map((hit) => hit.detector), ['secret-named']);
  assert.deepEqual(scanUrl('https://dev.example.com/cb#access_token=abcdefgh12345678&state=x').hits.map((hit) => hit.where), ['fragment:access_token']);
  assert.deepEqual(scanUrl('https://dev.example.com/page?sort=name&page=2').hits, []);
  assert.deepEqual(scanUrl('https://dev.example.com/login?token=abc').hits, [], 'too short to be a token');
  assert.equal(scanUrl('not a url').display, 'invalid-url');
});

test('names that say "secret" and the ones a page is meant to carry', () => {
  assert.ok(isSecretName('access_token', 'abcdefgh1234'));
  assert.ok(isSecretName('password', 'abcdefgh1234'));
  assert.ok(!isSecretName('access_token', 'short'));
  assert.ok(!isSecretName('__RequestVerificationToken', 'abcdefgh1234'), 'anti-forgery tokens belong in the page');
  assert.ok(!isSecretName('csrf_token', 'abcdefgh1234'));
  assert.ok(isSessionCookieName('app_session', 'a'.repeat(32)));
  assert.ok(!isSessionCookieName('theme', 'a'.repeat(32)));
  assert.ok(!isSessionCookieName('XSRF-TOKEN', 'a'.repeat(32)));
});

test('hostile text is bounded: 200k of digits, at-signs and separators finishes at once', () => {
  const started = Date.now();
  scanText('1'.repeat(200_000));
  scanText('a@'.repeat(100_000));
  scanText('1-'.repeat(100_000));
  scanText(`${'1 '.repeat(50_000)}9`);
  scanText('a.'.repeat(100_000) + '@' + 'b.'.repeat(1000));
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
});

test('the collector merges repeats, caps the list and never holds a raw value', () => {
  const collector = new FindingCollector({ key, maxFindings: 3 });
  collector.add('cpf', 'url', 'GET https://dev.example.com/a', CPF);
  collector.add('cpf', 'url', 'GET https://dev.example.com/a', CPF.replace(/\D/g, ''));
  collector.add('email', 'console', 'console.log', 'maria@example.com');
  collector.add('jwt', 'storage', 'localStorage["t"]', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop');
  assert.equal(collector.truncated, false);
  collector.add('card', 'response-body', 'GET x', CARD);
  assert.equal(collector.truncated, true);

  const findings = collector.findings();
  assert.equal(findings.length, 3);
  assert.equal(findings.find((finding) => finding.detector === 'cpf')?.count, 2);
  assert.deepEqual(findings.map((finding) => finding.severity), ['high', 'medium', 'low'], 'most severe first');
  const json = JSON.stringify(findings);
  for (const raw of [CPF, CPF.replace(/\D/g, ''), 'maria@example.com', 'abcdefghijklmnop']) assert.ok(!json.includes(raw), `a finding holds ${raw.slice(0, 5)}...`);
  assert.deepEqual(countFindings(findings).bySeverity, { high: 1, medium: 1, low: 1, info: 0 });
  assert.doesNotThrow(() => piiReportSchema.parse({ kind: 'pii-scan', findings, counts: countFindings(findings), scanned: { urls: 1, console: 1, responseBodies: 0, responseBodiesSkipped: 0, storageEntries: 1, jarEntries: 0, hiddenInputs: 0 }, truncated: true, notes: [] }));
});

test('default severities: a secret in a URL is high, an e-mail on a screen is informative, a session cookie is medium', () => {
  assert.equal(defaultSeverity('jwt', 'url'), 'high');
  assert.equal(defaultSeverity('secret-named', 'storage'), 'medium');
  assert.equal(defaultSeverity('cpf', 'response-body'), 'high');
  assert.equal(defaultSeverity('cpf', 'console'), 'medium');
  assert.equal(defaultSeverity('card', 'console'), 'high');
  assert.equal(defaultSeverity('email', 'url'), 'medium');
  assert.equal(defaultSeverity('email', 'response-body'), 'low');
  assert.equal(defaultSeverity('email', 'hidden-input'), 'info');
  assert.equal(defaultSeverity('cookie-no-httponly', 'cookie'), 'medium');
});

test('failOn levels', () => {
  assert.equal(meetsFailLevel('high', 'none'), false);
  assert.equal(meetsFailLevel('info', 'any'), true);
  assert.equal(meetsFailLevel('medium', 'high'), false);
  assert.equal(meetsFailLevel('high', 'medium'), true);
  assert.equal(meetsFailLevel('low', 'low'), true);
});

test('the step and the option are accepted; failOn defaults to none; unknown surfaces are refused', () => {
  const base = { targetUrl: 'https://dev.example.com', options: { piiScan: true } };
  const ok = explorationRequestSchema.parse({ ...base, steps: [{ action: 'goto', url: '$targetUrl' }, { action: 'scanForPii', name: 'pii' }] });
  assert.equal(ok.options.piiScan, true);
  const step = ok.steps[1];
  assert.equal(step?.action === 'scanForPii' && step.failOn, 'none');
  assert.equal(explorationRequestSchema.safeParse({ ...base, steps: [{ action: 'scanForPii', name: 'p', surfaces: ['mind'] }] }).success, false);
  assert.equal(explorationRequestSchema.safeParse({ ...base, steps: [{ action: 'scanForPii', name: 'p', failOn: 'critical' }] }).success, false);
  assert.equal(explorationRequestSchema.safeParse({ ...base, steps: [{ action: 'scanForPii', name: 'p', pattern: '.*' }] }).success, false, 'the caller sends no regular expression');
});

test('a run hunts only when it asks: the option or a scanForPii step', () => {
  assert.equal(usesPiiScan({ options: {}, steps: [{ action: 'goto' }] }), false);
  assert.equal(usesPiiScan({ options: { piiScan: true }, steps: [{ action: 'goto' }] }), true);
  assert.equal(usesPiiScan({ options: {}, steps: [{ action: 'goto' }], teardown: [{ action: 'scanForPii' }] }), true);
});

test('maskUrl and maskText hide what the hunt flags and keep the rest readable', async () => {
  const { maskText, maskUrl } = await import('../src/security/piiDetectors.js');
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop';
  const url = `https://dev.example.com/app?access_token=opaque-token-value&page=2#id_token=${jwt}`;
  const masked = maskUrl(url);
  assert.ok(!masked.includes('opaque-token-value') && !masked.includes(jwt));
  assert.match(masked, /^https:\/\/dev\.example\.com\/app\?access_token=\*\*\* \(18 chars\)&page=2#id_token=eyJ\*\*\*/);
  assert.equal(maskUrl('https://dev.example.com/list?sort=name'), 'https://dev.example.com/list?sort=name', 'nothing flagged, nothing changed');
  assert.equal(maskText(`document ${CPF} printed`), 'document ***.***.***-25 printed');
  assert.equal(maskText('nothing here'), 'nothing here');
  assert.equal(maskText('typed Tr0ub4dor&3', { knownSecrets: ['Tr0ub4dor&3'] }), 'typed *** (11 chars)');
});
