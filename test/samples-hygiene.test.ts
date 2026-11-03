import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// T0.1: samples are committed to a repo with a public-capable remote. They must never carry
// literal credentials, only placeholders such as "<LOGIN_USER>".
const samplesDir = path.resolve(import.meta.dirname, '..', 'samples');
const PLACEHOLDER = /^<[A-Z][A-Z0-9_]*>$/;

for (const file of readdirSync(samplesDir).filter((f) => f.endsWith('.json'))) {
  test(`samples/${file} has only placeholder credentials`, () => {
    const routine = JSON.parse(readFileSync(path.join(samplesDir, file), 'utf8')) as {
      credentials?: Record<string, unknown>;
    };
    for (const [name, value] of Object.entries(routine.credentials ?? {})) {
      assert.ok(
        typeof value === 'string' && PLACEHOLDER.test(value),
        `credential "${name}" in samples/${file} must be a placeholder like "<LOGIN_USER>"`,
      );
    }
  });
}
