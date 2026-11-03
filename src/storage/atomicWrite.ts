import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { retryTransient } from './transientIo.js';

/**
 * fs.rename with a short retry on the transient Windows errors (see transientIo.ts). Anything else, and a failure that outlasts the
 * retries, is thrown as it was. `rename` is injectable for tests.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  options: { attempts?: number; delayMs?: number; rename?: (from: string, to: string) => Promise<void> } = {},
): Promise<void> {
  const rename = options.rename ?? fs.rename;
  await retryTransient(() => rename(from, to), { ...(options.attempts ? { attempts: options.attempts } : {}), ...(options.delayMs ? { delayMs: options.delayMs } : {}), label: `renaming ${path.basename(to)}` });
}

/**
 * Writes via a temp file in the same directory and renames over the target, so a crash mid-write
 * can never leave a half-written (and, for the vault, undecryptable) file behind.
 */
export async function writeFileAtomic(filePath: string, data: string | Buffer, mode?: number): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const tmp = path.join(dir, `.${path.basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tmp, data, mode === undefined ? undefined : { mode });
    await renameWithRetry(tmp, filePath);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Serializes async operations that read-modify-write the same file within this process. */
export function createMutex(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();

  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}
