import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { renameWithRetry, writeFileAtomic } = await import('../src/storage/atomicWrite.js');

const failing = (code: string, times: number) => {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    rename: async () => {
      calls += 1;
      if (calls <= times) throw Object.assign(new Error(code), { code });
    },
  };
};

test('a transient Windows rename error is retried and then succeeds', async () => {
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    const fake = failing(code, 2);
    await renameWithRetry('a', 'b', { delayMs: 1, rename: fake.rename });
    assert.equal(fake.calls, 3, code);
  }
});

test('a failure that outlasts the retries is thrown as it was; other errors are not retried at all', async () => {
  const stuck = failing('EPERM', 99);
  await assert.rejects(renameWithRetry('a', 'b', { attempts: 3, delayMs: 1, rename: stuck.rename }), { code: 'EPERM' });
  assert.equal(stuck.calls, 3);

  const missing = failing('ENOENT', 99);
  await assert.rejects(renameWithRetry('a', 'b', { delayMs: 1, rename: missing.rename }), { code: 'ENOENT' });
  assert.equal(missing.calls, 1, 'ENOENT is not transient');
});

test('writeFileAtomic still writes, replaces and leaves no temp file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-atomic-'));
  try {
    const file = path.join(dir, 'sub', 'x.json');
    await writeFileAtomic(file, 'one');
    await writeFileAtomic(file, 'two');
    assert.equal(fs.readFileSync(file, 'utf8'), 'two');
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['x.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const { retryTransient, readFileRetry } = await import('../src/storage/transientIo.js');

test('retryTransient: a flaky operation succeeds after the contention passes; the result is the operation\'s', async () => {
  let calls = 0;
  const value = await retryTransient(async () => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return 'done';
  }, { delayMs: 1 });
  assert.deepEqual([value, calls], ['done', 3]);
});

test('retryTransient: a lasting EPERM is thrown after the attempts; a non-transient error is thrown at once', async () => {
  let calls = 0;
  await assert.rejects(retryTransient(async () => { calls += 1; throw Object.assign(new Error('x'), { code: 'EPERM' }); }, { attempts: 4, delayMs: 1 }), { code: 'EPERM' });
  assert.equal(calls, 4);

  calls = 0;
  await assert.rejects(retryTransient(async () => { calls += 1; throw Object.assign(new Error('x'), { code: 'ENOENT' }); }, { delayMs: 1 }), { code: 'ENOENT' });
  assert.equal(calls, 1);
  await assert.rejects(retryTransient(async () => { throw new Error('no code'); }, { delayMs: 1 }), /no code/);
});

test('readFileRetry: reads text and bytes; a missing file is ENOENT immediately, not after a wait', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-read-'));
  try {
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'hello');
    assert.equal(await readFileRetry(file, 'utf8'), 'hello');
    assert.equal((await readFileRetry(file)).toString(), 'hello');
    const started = Date.now();
    await assert.rejects(readFileRetry(path.join(dir, 'missing.txt'), 'utf8'), { code: 'ENOENT' });
    assert.ok(Date.now() - started < 200, 'no retry pause for ENOENT');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
