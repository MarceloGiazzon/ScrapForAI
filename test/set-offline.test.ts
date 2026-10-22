import assert from 'node:assert/strict';
import test from 'node:test';
import { explorationStepSchema } from '../src/schemas/explorationRequest.schema.js';

test('setOffline accepts a boolean and nothing else', () => {
  assert.equal(explorationStepSchema.safeParse({ id: 's1', action: 'setOffline', offline: true }).success, true);
  assert.equal(explorationStepSchema.safeParse({ id: 's2', action: 'setOffline', offline: false }).success, true);
  assert.equal(explorationStepSchema.safeParse({ id: 's3', action: 'setOffline' }).success, false);
  assert.equal(explorationStepSchema.safeParse({ id: 's4', action: 'setOffline', offline: 'yes' }).success, false);
  assert.equal(explorationStepSchema.safeParse({ id: 's5', action: 'setOffline', offline: true, extra: 1 }).success, false);
});
