import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import dotenv from 'dotenv';

import { EXAMPLE_API_KEY, EXAMPLE_TARGET_ORIGINS, findExampleConfig, formatExampleConfigError } from '../src/config/exampleConfig.js';

const real = { SCRAPFORAI_API_KEY: 'k3y-that-a-person-generated-0123456789', ALLOWED_TARGET_ORIGINS: ['http://localhost:5173'] };

test('the constants are exactly what .env.example ships (so copying it unchanged is always caught)', () => {
  const example = dotenv.parse(readFileSync(path.resolve(import.meta.dirname, '..', '.env.example')));
  assert.equal(example.SCRAPFORAI_API_KEY, EXAMPLE_API_KEY);
  const origins = (example.ALLOWED_TARGET_ORIGINS ?? '').split(',').map((origin) => origin.trim());
  assert.deepEqual([...origins].sort(), [...EXAMPLE_TARGET_ORIGINS].sort());
});

test('an unchanged copy of .env.example is refused on both counts', () => {
  const problems = findExampleConfig({ SCRAPFORAI_API_KEY: EXAMPLE_API_KEY, ALLOWED_TARGET_ORIGINS: [...EXAMPLE_TARGET_ORIGINS] });
  assert.deepEqual(problems.map((problem) => problem.variable).sort(), ['ALLOWED_TARGET_ORIGINS', 'SCRAPFORAI_API_KEY']);
});

test('a real key and a real origin are accepted', () => {
  assert.deepEqual(findExampleConfig(real), []);
});

test('only the key still being the example is one problem, and vice versa', () => {
  assert.deepEqual(findExampleConfig({ ...real, SCRAPFORAI_API_KEY: EXAMPLE_API_KEY }).map((problem) => problem.variable), ['SCRAPFORAI_API_KEY']);
  assert.deepEqual(findExampleConfig({ ...real, ALLOWED_TARGET_ORIGINS: [...EXAMPLE_TARGET_ORIGINS] }).map((problem) => problem.variable), ['ALLOWED_TARGET_ORIGINS']);
});

test('a key that merely starts like the placeholder is still the example, whatever the case or padding', () => {
  for (const key of ['replace-with-strong-random-value-123', '  REPLACE-WITH-STRONG-RANDOM-VALUE  ', 'Replace-With-Something']) {
    assert.equal(findExampleConfig({ ...real, SCRAPFORAI_API_KEY: key }).length, 1, key);
  }
});

test('one example host on its own, or the example hosts next to a real one, is a choice and is accepted', () => {
  assert.deepEqual(findExampleConfig({ ...real, ALLOWED_TARGET_ORIGINS: ['https://dev.example.com'] }), []);
  assert.deepEqual(findExampleConfig({ ...real, ALLOWED_TARGET_ORIGINS: [...EXAMPLE_TARGET_ORIGINS, 'http://localhost:5173'] }), []);
});

test('the order of the example origins does not matter', () => {
  assert.equal(findExampleConfig({ ...real, ALLOWED_TARGET_ORIGINS: [EXAMPLE_TARGET_ORIGINS[1], EXAMPLE_TARGET_ORIGINS[0]] }).length, 1);
});

test('the refusal says what to do and never prints the key it found', () => {
  const secretLooking = `${EXAMPLE_API_KEY}-and-a-suffix-that-must-not-be-echoed`;
  const text = formatExampleConfigError(findExampleConfig({ SCRAPFORAI_API_KEY: secretLooking, ALLOWED_TARGET_ORIGINS: [...EXAMPLE_TARGET_ORIGINS] }));
  assert.match(text, /randomBytes\(32\)/);
  assert.match(text, /ALLOWED_TARGET_ORIGINS=http:\/\/localhost:5173/);
  assert.match(text, /scheme \+ host \+ port/);
  assert.match(text, /npm run doctor/);
  assert.ok(!text.includes('suffix-that-must-not-be-echoed'));
});
