import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// T5.7, the pure half: the step schema, the secret lint of a body, the method policy of a target profile (resolve) and the branch rule.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-http-test-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com';

const { explorationRequestSchema } = await import('../src/schemas/explorationRequest.schema.js');
const { targetProfileSchema } = await import('../src/schemas/targetProfile.schema.js');
const { resolveExplorationRequest, RequestResolutionError } = await import('../src/runner/resolveRequest.js');
const { saveTarget } = await import('../src/targets/targetStore.js');
const { lintRoutineSteps } = await import('../src/library/routineLint.js');
const { extractedNamesOf } = await import('../src/schemas/stepTree.js');
const { resolveHttpUrl } = await import('../src/runner/httpRequest.js');

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const parse = (steps: unknown[]) => explorationRequestSchema.safeParse({ targetUrl: 'https://dev.example.com/app', steps });
const call = (over: Record<string, unknown> = {}) => ({ action: 'httpRequest', name: 'r', method: 'GET', url: '/api/x', ...over });

// ---- schema

test('schema: a GET with a path is accepted; the method list is closed', () => {
  assert.ok(parse([call()]).success);
  assert.ok(!parse([call({ method: 'TRACE' })]).success);
  assert.ok(!parse([call({ method: 'get' })]).success, 'methods are upper case');
});

test('schema: GET and HEAD carry no body; a contentType needs a body', () => {
  assert.ok(!parse([call({ body: '{}' })]).success);
  assert.ok(!parse([call({ method: 'HEAD', body: '{}' })]).success);
  assert.ok(parse([call({ method: 'POST', body: '{"a":1}' })]).success);
  assert.ok(parse([call({ method: 'POST', body: 'a=1', contentType: 'application/x-www-form-urlencoded' })]).success);
  assert.ok(!parse([call({ method: 'POST', contentType: 'application/json' })]).success);
});

test('schema: the caller cannot send headers (an Authorization header would be a secret in a routine)', () => {
  assert.ok(!parse([call({ headers: { authorization: 'Bearer x' } })]).success);
  assert.ok(!parse([call({ method: 'POST', body: '{}', contentType: 'a b' })]).success);
});

test('schema: extract needs exactly one of json / header, distinct names, and never a session header', () => {
  assert.ok(parse([call({ extract: [{ name: 'total', json: 'a.b' }, { name: 'rid', header: 'x-request-id' }] })]).success);
  assert.ok(!parse([call({ extract: [{ name: 'a' }] })]).success);
  assert.ok(!parse([call({ extract: [{ name: 'a', json: 'x', header: 'y' }] })]).success);
  assert.ok(!parse([call({ extract: [{ name: 'a', json: 'x' }, { name: 'a', json: 'y' }] })]).success, 'same name twice');
  assert.ok(!parse([call({ extract: [{ name: 'r', json: 'x' }] })]).success, 'the step name is taken');
  for (const header of ['Set-Cookie', 'authorization', 'Cookie']) {
    assert.ok(!parse([call({ extract: [{ name: 'a', header }] })]).success, header);
  }
});

test('schema: expectStatus is a list of real status codes', () => {
  assert.ok(parse([call({ expectStatus: [200, 404] })]).success);
  assert.ok(!parse([call({ expectStatus: [] })]).success);
  assert.ok(!parse([call({ expectStatus: [99] })]).success);
});

test('schema: an httpRequest is a leaf, so it may be in a teardown and in a parallel branch; extract names count for the race rule', () => {
  assert.ok(explorationRequestSchema.safeParse({ targetUrl: 'https://dev.example.com/app', steps: [call()], teardown: [call({ name: 't' })] }).success);
  const twoBranches = (nameB: string) =>
    parse([
      {
        action: 'parallel',
        branches: [
          [call({ name: 'a1', actor: 'alice', extract: [{ name: 'id', json: 'id' }] })],
          [call({ name: nameB, actor: 'bob', extract: [{ name: 'id', json: 'id' }] })],
        ],
      },
    ]);
  const result = twoBranches('b1');
  assert.ok(!result.success, 'both branches would write "id"');
});

test('stepTree: extractedNamesOf lists the step name and each extract entry', () => {
  assert.deepEqual(extractedNamesOf({ action: 'httpRequest', name: 'r', extract: [{ name: 'a' }, { name: 'b' }] }), ['r', 'a', 'b']);
  assert.deepEqual(extractedNamesOf({ action: 'extractText', name: 'x' }), ['x']);
  assert.deepEqual(extractedNamesOf({ action: 'screenshot', name: 's' }), []);
});

// ---- lint

test('lint: a secret in a body is refused, and the message does not echo it', () => {
  const key = `sk-${'a1B2c3D4'.repeat(4)}`;
  const steps = explorationRequestSchema.parse({ targetUrl: 'https://dev.example.com/app', steps: [call({ method: 'POST', body: `{"key":"${key}"}` })] }).steps;
  const issues = lintRoutineSteps(steps, []);
  assert.equal(issues.length, 1);
  assert.match(issues[0]!.path, /body$/);
  assert.ok(!issues[0]!.message.includes(key));
  const vaulted = lintRoutineSteps(steps, ['{"key"']);
  assert.ok(vaulted.length >= 1);
});

// ---- profile schema

test('profile: http.allowedMethods is optional, closed and non-empty', () => {
  const base = { id: 'p', name: 'P', environment: 'dev', baseUrl: 'https://dev.example.com/app' };
  assert.ok(targetProfileSchema.safeParse(base).success);
  assert.ok(targetProfileSchema.safeParse({ ...base, http: { allowedMethods: ['GET', 'POST'] } }).success);
  assert.ok(!targetProfileSchema.safeParse({ ...base, http: { allowedMethods: [] } }).success);
  assert.ok(!targetProfileSchema.safeParse({ ...base, http: { allowedMethods: ['CONNECT'] } }).success);
});

// ---- urls

test('resolveHttpUrl: a path resolves against the target; an address off the allowlist is refused', () => {
  assert.equal(resolveHttpUrl('/api/x?y=1', 'https://dev.example.com/app'), 'https://dev.example.com/api/x?y=1');
  assert.throws(() => resolveHttpUrl('https://evil.example.org/x', 'https://dev.example.com/app'));
  assert.throws(() => resolveHttpUrl('http://169.254.169.254/latest/meta-data', 'https://dev.example.com/app'));
});

// ---- method policy (resolve)

test('resolve: only the methods the profile lists are allowed (default GET/HEAD), also through a teardown', async () => {
  const profile = (id: string, http?: { allowedMethods: string[] }) => ({
    id,
    name: id,
    platform: 'generic' as const,
    environment: 'dev' as const,
    baseUrl: 'https://dev.example.com/app',
    credentialSets: [],
    noiseFilters: [],
    surfaces: {},
    screens: [],
    ...(http ? { http } : {}),
    flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  });
  await saveTarget(profile('plain') as never);
  await saveTarget(profile('writer', { allowedMethods: ['GET', 'POST'] }) as never);

  const withMethod = (targetProfile: string | undefined, method: string, where: 'steps' | 'teardown' = 'steps') =>
    explorationRequestSchema.parse({
      ...(targetProfile ? { targetProfile } : { targetUrl: 'https://dev.example.com/app' }),
      steps: where === 'steps' ? [call({ method, ...(method === 'GET' ? {} : { body: '{}' }) })] : [call()],
      ...(where === 'teardown' ? { teardown: [call({ method, body: '{}' })] } : {}),
    });

  await resolveExplorationRequest(withMethod('plain', 'GET'));
  await resolveExplorationRequest(withMethod(undefined, 'GET'));
  await assert.rejects(
    () => resolveExplorationRequest(withMethod('plain', 'POST')),
    (error: unknown) => error instanceof RequestResolutionError && error.status === 403 && error.name === 'HttpMethodNotAllowed' && /http\.allowedMethods/.test(error.message),
  );
  await assert.rejects(() => resolveExplorationRequest(withMethod(undefined, 'POST')), (error: unknown) => error instanceof RequestResolutionError && error.status === 403);
  await assert.rejects(() => resolveExplorationRequest(withMethod('plain', 'DELETE', 'teardown')), (error: unknown) => error instanceof RequestResolutionError && error.status === 403);

  const allowed = await resolveExplorationRequest(withMethod('writer', 'POST'));
  assert.deepEqual(allowed.httpMethods, ['GET', 'POST']);
  await assert.rejects(() => resolveExplorationRequest(withMethod('writer', 'DELETE')), (error: unknown) => error instanceof RequestResolutionError && error.status === 403);
});
