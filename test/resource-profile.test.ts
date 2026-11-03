import assert from 'node:assert/strict';
import test from 'node:test';

// T5.2, the pure half: the options schema (stylesheet is refused by name), which types a run stubs, and what the policy answers.

process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com';

const { explorationRequestSchema, explorationOptionsSchema, stubbedResourceTypes } = await import('../src/schemas/explorationRequest.schema.js');
const { resourceStubPolicy, buildPolicies, decide, TRANSPARENT_PNG, ALLOWLIST_GUARD } = await import('../src/runner/routing.js');

const request = (options: Record<string, unknown>) =>
  explorationRequestSchema.safeParse({ targetUrl: 'https://dev.example.com/', steps: [{ id: 'a', action: 'goto', url: 'https://dev.example.com/' }], options });

test('defaults: profile full, nothing stubbed', () => {
  const options = explorationOptionsSchema.parse({});
  assert.equal(options.profile, 'full');
  assert.deepEqual(stubbedResourceTypes(options), []);
  assert.ok(request({}).success);
});

test('functional stubs image, media and font; an explicit list wins (an empty list = none)', () => {
  assert.deepEqual(stubbedResourceTypes(explorationOptionsSchema.parse({ profile: 'functional' })), ['image', 'media', 'font']);
  assert.deepEqual(stubbedResourceTypes(explorationOptionsSchema.parse({ profile: 'functional', resourcePolicy: { stub: ['image'] } })), ['image']);
  assert.deepEqual(stubbedResourceTypes(explorationOptionsSchema.parse({ profile: 'functional', resourcePolicy: { stub: [] } })), []);
  assert.deepEqual(stubbedResourceTypes(explorationOptionsSchema.parse({ profile: 'full', resourcePolicy: { stub: ['font', 'font'] } })), ['font'], 'explicit works under full too, deduplicated');
});

test('stylesheet can never be stubbed, and nothing but image/media/font can', () => {
  const css = request({ profile: 'functional', resourcePolicy: { stub: ['image', 'stylesheet'] } });
  assert.equal(css.success, false);
  assert.match(JSON.stringify(css.error?.issues), /stylesheet can never be stubbed: element visibility in the browser depends on CSS/);
  for (const bad of ['script', 'document', 'fetch', 'xhr', 'IMAGE']) {
    const result = request({ resourcePolicy: { stub: [bad] } });
    assert.equal(result.success, false, bad);
    assert.match(JSON.stringify(result.error?.issues), /cannot stub/);
  }
  assert.equal(request({ resourcePolicy: { stub: ['image'], surprise: 1 } }).success, false);
  assert.equal(request({ profile: 'turbo' }).success, false);
  assert.equal(request({ resourcePolicy: { stub: ['image', 'media', 'font', 'image'] } }).success, false, 'more than three entries is refused');
});

const req = (resourceType: string, over: Record<string, unknown> = {}) => ({ url: 'https://dev.example.com/x', method: 'GET', resourceType, isNavigation: false, ...over });

test('the policy: a decodable PNG for images, 204 for media and fonts, everything else (CSS, script, fetch, navigation) untouched', () => {
  const policy = resourceStubPolicy(['image', 'media', 'font']);
  const image = policy(req('image'));
  assert.deepEqual([image?.action, image?.handledBy], ['fulfill', 'resource-policy:image']);
  assert.equal((image as { status: number }).status, 200);
  assert.equal((image as { contentType: string }).contentType, 'image/png');
  assert.deepEqual([...(image as { body: Buffer }).body.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
  assert.equal(TRANSPARENT_PNG.readUInt32BE(16), 1, 'width 1');
  assert.equal(TRANSPARENT_PNG.readUInt32BE(20), 1, 'height 1');

  for (const type of ['media', 'font']) {
    const answer = policy(req(type)) as { status: number; handledBy: string; body?: unknown };
    assert.deepEqual([answer.status, answer.handledBy, answer.body], [204, `resource-policy:${type}`, undefined]);
  }
  for (const type of ['stylesheet', 'script', 'fetch', 'xhr', 'document']) assert.equal(policy(req(type)), undefined, type);
  assert.equal(policy(req('image', { isNavigation: true })), undefined, 'a navigation is never stubbed');
  assert.equal(resourceStubPolicy(['font'])(req('image')), undefined, 'only what was asked for');
  assert.equal(resourceStubPolicy([])(req('image')), undefined);
});

test('order: the allowlist guard answers before the resource policy', () => {
  const policies = buildPolicies({ blockUnexpected: true, resources: [resourceStubPolicy(['image'])] });
  assert.equal(decide(req('image', { url: 'https://evil.example.org/p.png' }), policies)?.handledBy, ALLOWLIST_GUARD);
  assert.equal(decide(req('image'), policies)?.handledBy, 'resource-policy:image');
});
