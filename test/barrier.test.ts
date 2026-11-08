import assert from 'node:assert/strict';
import test from 'node:test';

// `barrier`, the meeting point inside the branches of a `parallel` block (pure part). The browser side is test/parallel.smoke.ts.

const { BarrierGroup, BarrierBrokenError, BarrierTimeoutError } = await import('../src/runner/barrier.js');

const labels = ['branch 0 (alice)', 'branch 1 (bob)', 'branch 2 (carol)'];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Settles to a short description, so a test can assert on how a promise ended without an unhandled rejection. */
const outcome = (promise: Promise<void>): Promise<string> =>
  promise.then(
    () => 'released',
    (error: Error) => `${error.name}: ${error.message}`,
  );

test('nobody goes on before the last branch arrives; then all of them do', async () => {
  const group = new BarrierGroup(labels);
  const order: string[] = [];
  const branch = async (party: number, delayMs: number) => {
    await sleep(delayMs);
    order.push(`arrive ${party}`);
    await group.arrive('go', party, 2000);
    order.push(`go ${party}`);
  };
  await Promise.all([branch(0, 0), branch(1, 60), branch(2, 120)]);
  assert.deepEqual(order.slice(0, 3), ['arrive 0', 'arrive 1', 'arrive 2'], 'every arrival comes before any departure');
  assert.deepEqual(order.slice(3).sort(), ['go 0', 'go 1', 'go 2']);
});

test('barriers are met in order, and each one is a meeting of its own', async () => {
  const group = new BarrierGroup(labels.slice(0, 2));
  const seen: string[] = [];
  const branch = async (party: number, first: number, second: number) => {
    await sleep(first);
    await group.arrive('ready', party, 2000);
    seen.push(`ready ${party}`);
    await sleep(second);
    await group.arrive('done', party, 2000);
    seen.push(`done ${party}`);
  };
  await Promise.all([branch(0, 0, 80), branch(1, 40, 0)]);
  assert.deepEqual(seen.slice(0, 2).sort(), ['ready 0', 'ready 1']);
  assert.deepEqual(seen.slice(2).sort(), ['done 0', 'done 1']);
});

test('a branch that fails before the barrier frees the others with an error that names it; they never go on alone', async () => {
  const group = new BarrierGroup(labels.slice(0, 2));
  const waiting = outcome(group.arrive('go', 0, 2000));
  await sleep(20);
  group.leave(1, 'failed');
  assert.equal(await waiting, 'BarrierBrokenError: barrier "go" can no longer happen: branch 1 (bob) failed before reaching it');
  // A branch that gets there later is refused at once, with the same reason.
  assert.match(await outcome(group.arrive('go', 0, 2000)).catch(() => 'x'), /BarrierBrokenError/);
});

test('a branch that simply ran out of steps is "ended", not "failed"', async () => {
  const group = new BarrierGroup(labels.slice(0, 2));
  group.leave(1, 'finished');
  assert.equal(await outcome(group.arrive('go', 0, 2000)), 'BarrierBrokenError: barrier "go" can no longer happen: branch 1 (bob) ended before reaching it');
});

test('a branch that leaves AFTER a barrier was met changes nothing about it', async () => {
  const group = new BarrierGroup(labels.slice(0, 2));
  const a = outcome(group.arrive('go', 0, 2000));
  const b = outcome(group.arrive('go', 1, 2000));
  assert.deepEqual(await Promise.all([a, b]), ['released', 'released']);
  group.leave(0, 'finished');
  group.leave(1, 'failed');
  // ...but the next barrier, which they did not both reach, is broken.
  assert.match(await outcome(group.arrive('second', 0, 100)), /BarrierBrokenError.*branch 1 \(bob\) failed/);
});

test('a timeout names who it was waiting for; the late arrival is then told it can no longer happen', async () => {
  const group = new BarrierGroup(labels);
  group.arrive('go', 1, 5000).catch(() => undefined);
  const early = outcome(group.arrive('go', 0, 40));
  const message = await early;
  assert.match(message, /^BarrierTimeoutError: barrier "go": still waiting for branch 2 \(carol\) after 40 ms$/);
  assert.ok(!message.includes('branch 1 (bob)'), 'bob had arrived');
  // Alice ends after her timeout, so the meeting cannot happen: carol, arriving late, is told so instead of waiting for bob and nobody else.
  group.leave(0, 'failed');
  assert.match(await outcome(group.arrive('go', 2, 2000)), /BarrierBrokenError: barrier "go" can no longer happen: branch 0 \(alice\) failed before reaching it/);
});

test('errors are real classes, and arriving twice is a bug that says so', async () => {
  assert.equal(new BarrierBrokenError('x').name, 'BarrierBrokenError');
  assert.equal(new BarrierTimeoutError('x').name, 'BarrierTimeoutError');
  const group = new BarrierGroup(labels.slice(0, 2));
  group.arrive('go', 0, 50).catch(() => undefined);
  assert.equal(await outcome(group.arrive('go', 0, 50)), 'Error: branch 0 (alice) reached barrier "go" twice');
});
