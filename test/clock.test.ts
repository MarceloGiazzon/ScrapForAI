import assert from 'node:assert/strict';
import test from 'node:test';

// T7.3, the pure half: what setClock accepts. The browser behaviour is in clock.smoke.ts.

process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com';

const { explorationRequestSchema } = await import('../src/schemas/explorationRequest.schema.js');
const { humanSpan } = await import('../src/reports/render.js');

const parse = (step: Record<string, unknown>) => explorationRequestSchema.safeParse({ targetUrl: 'https://dev.example.com/', steps: [{ action: 'setClock', ...step }] });

test('setClock takes exactly one of fixedTime / installAt, with an explicit zone', () => {
  assert.ok(parse({ fixedTime: '2030-01-31T23:59:50Z' }).success);
  assert.ok(parse({ fixedTime: '2030-01-31T23:59:50-03:00' }).success);
  assert.ok(parse({ fixedTime: '2030-01-31T23:59:50.123+05:30' }).success);
  assert.ok(parse({ installAt: '2030-01-31T23:59:50Z' }).success);
  assert.ok(parse({ installAt: '2030-01-31T23:59:50Z', fastForwardMs: 3_600_000 }).success);

  assert.ok(!parse({}).success, 'nothing to do');
  assert.ok(!parse({ fixedTime: '2030-01-31T23:59:50Z', installAt: '2030-01-31T23:59:50Z' }).success, 'both');
});

test('a time without a zone, a bare date or a nonsense value is refused: the machine must not decide which day it is', () => {
  for (const bad of ['2030-01-31T23:59:50', '2030-01-31', 'tomorrow', '31/01/2030', '', '2030-13-01T00:00:00Z', 1_900_000_000_000]) {
    assert.ok(!parse({ fixedTime: bad }).success, String(bad));
  }
});

test('seconds are required: zod >= 4.6 stopped accepting "10:00Z", and the published JSON Schema says so too', () => {
  // Valid ISO 8601, accepted by zod 4.4. Pinned so a later zod upgrade cannot change the contract without a failing test.
  for (const minutesOnly of ['2030-01-31T23:59Z', '2030-01-31T23:59-03:00']) {
    assert.ok(!parse({ fixedTime: minutesOnly }).success, minutesOnly);
    assert.ok(!parse({ installAt: minutesOnly }).success, minutesOnly);
  }
});

test('the year must be between 1970 and 2100', () => {
  assert.ok(!parse({ fixedTime: '1969-12-31T23:59:59Z' }).success);
  assert.ok(!parse({ fixedTime: '2101-01-01T00:00:00Z' }).success);
  assert.ok(parse({ fixedTime: '1970-01-01T00:00:00Z' }).success);
  assert.ok(parse({ fixedTime: '2100-12-31T23:59:59Z' }).success);
});

test('fastForwardMs only goes with installAt, and must be a positive whole number of at most ten years', () => {
  assert.ok(!parse({ fixedTime: '2030-01-01T00:00:00Z', fastForwardMs: 1000 }).success);
  assert.ok(!parse({ installAt: '2030-01-01T00:00:00Z', fastForwardMs: 0 }).success);
  assert.ok(!parse({ installAt: '2030-01-01T00:00:00Z', fastForwardMs: -5 }).success);
  assert.ok(!parse({ installAt: '2030-01-01T00:00:00Z', fastForwardMs: 1.5 }).success);
  assert.ok(!parse({ installAt: '2030-01-01T00:00:00Z', fastForwardMs: 315_360_000_001 }).success);
  assert.ok(parse({ installAt: '2030-01-01T00:00:00Z', fastForwardMs: 315_360_000_000 }).success);
});

test('humanSpan reads like a person would say it', () => {
  assert.equal(humanSpan(250), '250 ms');
  assert.equal(humanSpan(1000), '1 s');
  assert.equal(humanSpan(90_000), '1 min 30 s');
  assert.equal(humanSpan(3_600_000), '1 h');
  assert.equal(humanSpan(86_400_000), '1 d');
  assert.equal(humanSpan(90_061_000), '1 d 1 h 1 min 1 s');
});
