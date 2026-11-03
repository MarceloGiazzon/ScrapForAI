import assert from 'node:assert/strict';
import test from 'node:test';

import { JobCancelledError, JobQueue } from '../src/orchestrator/jobQueue.js';

/** A task the test finishes by hand, so ordering is observed without any real clock. */
function manual() {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { done, finish };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function queue(max: number, reservedForInteractive = 0): JobQueue {
  return new JobQueue(() => ({ max, reservedForInteractive }));
}

test('never runs more than `max` tasks at once; the rest wait their turn', async () => {
  const q = queue(2);
  let running = 0;
  let peak = 0;
  const gates = Array.from({ length: 5 }, manual);

  const results = gates.map((gate, index) =>
    q.run(
      async () => {
        running += 1;
        peak = Math.max(peak, running);
        await gate.done;
        running -= 1;
        return index;
      },
      { priority: 'suite' },
    ),
  );

  await tick();
  assert.equal(q.stats().running, 2);
  assert.equal(q.stats().waiting, 3);

  for (const gate of gates) {
    gate.finish();
    await tick();
  }

  assert.deepEqual(await Promise.all(results), [0, 1, 2, 3, 4]);
  assert.equal(peak, 2);
  assert.deepEqual(q.stats(), { running: 0, waiting: 0, locks: {} });
});

test('priority: interactive > suite > scheduled; FIFO within a priority', async () => {
  const q = queue(1);
  const order: string[] = [];
  const first = manual();

  const blocker = q.run(() => first.done, { priority: 'suite' });
  await tick();

  const enqueue = (name: string, priority: 'interactive' | 'suite' | 'scheduled') =>
    q.run(async () => void order.push(name), { priority });

  const rest = [
    enqueue('scheduled-1', 'scheduled'),
    enqueue('suite-1', 'suite'),
    enqueue('suite-2', 'suite'),
    enqueue('interactive-1', 'interactive'),
  ];

  first.finish();
  await Promise.all([blocker, ...rest]);
  assert.deepEqual(order, ['interactive-1', 'suite-1', 'suite-2', 'scheduled-1']);
});

test('suites and scheduled runs cannot take the slots reserved for interactive work', async () => {
  const q = queue(3, 1);
  const gates = [manual(), manual(), manual()];

  const suiteRuns = gates.map((gate) => q.run(() => gate.done, { priority: 'suite' }));
  await tick();
  assert.equal(q.stats().running, 2, 'only 2 of 3 slots are available to suites');

  const interactive = q.tryAcquire({ priority: 'interactive' });
  assert.equal(interactive.ok, true, 'the reserved slot is still free for an ad-hoc run');

  assert.deepEqual(q.tryAcquire({ priority: 'interactive' }), { ok: false, reason: 'capacity' });

  if (interactive.ok) interactive.release();
  gates.forEach((gate) => gate.finish());
  await Promise.all(suiteRuns);
});

test('a reservation never leaves a suite without a slot, even when max is 1', async () => {
  const q = queue(1, 5);
  let ran = false;
  await q.run(async () => void (ran = true), { priority: 'suite' });
  assert.equal(ran, true);
});

test('credential lock: two tasks with the same key never run at the same time', async () => {
  const q = queue(4);
  let concurrentOnSameKey = 0;
  let peak = 0;
  const gates = Array.from({ length: 3 }, manual);

  const runs = gates.map((gate) =>
    q.run(
      async () => {
        concurrentOnSameKey += 1;
        peak = Math.max(peak, concurrentOnSameKey);
        await gate.done;
        concurrentOnSameKey -= 1;
      },
      { priority: 'suite', lockKey: 'gam-admin' },
    ),
  );

  await tick();
  assert.equal(q.stats().running, 1, 'three slots are free but the credential allows one session');
  assert.deepEqual(q.stats().locks, { 'gam-admin': 1 });

  for (const gate of gates) {
    gate.finish();
    await tick();
  }
  await Promise.all(runs);
  assert.equal(peak, 1);
});

test('maxPerLock > 1 lets that many sessions share a credential', async () => {
  const q = queue(4);
  const gates = [manual(), manual(), manual()];
  const runs = gates.map((gate) => q.run(() => gate.done, { priority: 'suite', lockKey: 'shared', maxPerLock: 2 }));
  await tick();
  assert.equal(q.stats().running, 2);
  gates.forEach((gate) => gate.finish());
  await Promise.all(runs);
});

test('a task blocked on a lock does not block the ones behind it', async () => {
  const q = queue(3);
  const holder = manual();
  const order: string[] = [];

  const first = q.run(() => holder.done, { priority: 'suite', lockKey: 'a' });
  const blocked = q.run(async () => void order.push('a-again'), { priority: 'suite', lockKey: 'a' });
  const other = q.run(async () => void order.push('b'), { priority: 'suite', lockKey: 'b' });
  const free = q.run(async () => void order.push('no-lock'), { priority: 'suite' });

  await Promise.all([other, free]);
  assert.deepEqual(order.sort(), ['b', 'no-lock'], 'later tasks ran while a-again was still waiting');
  assert.equal(q.stats().waiting, 1);

  holder.finish();
  await Promise.all([first, blocked]);
  assert.ok(order.includes('a-again'));
});

test('a lock is released when the task throws, so the next one still runs', async () => {
  const q = queue(2);
  await assert.rejects(() => q.run(async () => { throw new Error('boom'); }, { priority: 'suite', lockKey: 'k' }), /boom/);
  assert.equal(await q.run(async () => 'ok', { priority: 'suite', lockKey: 'k' }), 'ok');
  assert.deepEqual(q.stats(), { running: 0, waiting: 0, locks: {} });
});

test('aborting a waiting task rejects it with JobCancelled and frees nothing it did not hold', async () => {
  const q = queue(1);
  const holder = manual();
  const controller = new AbortController();

  const running = q.run(() => holder.done, { priority: 'suite' });
  const waiting = q.run(async () => 'never', { priority: 'suite', signal: controller.signal });
  await tick();

  controller.abort();
  await assert.rejects(() => waiting, (error: Error) => error instanceof JobCancelledError);
  assert.equal(q.stats().waiting, 0);
  assert.equal(q.stats().running, 1, 'the running task was not interrupted');

  await assert.rejects(() => q.run(async () => 'x', { priority: 'suite', signal: controller.signal }), JobCancelledError, 'an already-aborted signal never queues');

  holder.finish();
  await running;
});

test('tryAcquire answers at once with the reason: capacity or lock', async () => {
  const q = queue(2);

  const first = q.tryAcquire({ lockKey: 'cred' });
  assert.equal(first.ok, true);
  assert.deepEqual(q.tryAcquire({ lockKey: 'cred' }), { ok: false, reason: 'lock' });

  const second = q.tryAcquire({});
  assert.equal(second.ok, true);
  assert.deepEqual(q.tryAcquire({}), { ok: false, reason: 'capacity' });

  if (first.ok) { first.release(); first.release(); } // releasing twice must not free a second slot
  assert.equal(q.stats().running, 1);
  assert.equal(q.tryAcquire({ lockKey: 'cred' }).ok, true);
  if (second.ok) second.release();
});

test('a task waiting on capacity starts as soon as a synchronous slot is released', async () => {
  const q = queue(1);
  const sync = q.tryAcquire({});
  assert.equal(sync.ok, true);

  let started = false;
  const waiting = q.run(async () => void (started = true), { priority: 'suite' });
  await tick();
  assert.equal(started, false);

  if (sync.ok) sync.release();
  await waiting;
  assert.equal(started, true);
});
