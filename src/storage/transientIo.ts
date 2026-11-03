import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Windows briefly refuses to open, read or rename a file that another process (antivirus, the search indexer, a backup agent,
 * a reader) has just opened: EPERM, EBUSY or EACCES, gone in milliseconds. A run writes dozens of small files and reads them back
 * at once (hash for the manifest, result.json for the API, screenshots for a report), so without a retry the occasional refusal
 * surfaces as "evidence not found" far from its cause, because most of those reads sit behind a `.catch(() => undefined)`.
 *
 * Retried: only those three codes, a few times, with a growing pause. Anything else (ENOENT, a real permission problem that
 * lasts) is thrown as it was after at most the same short wait. This is the approach of graceful-fs.
 */

export const TRANSIENT_FS_ERRORS: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);

export interface RetryOptions {
  attempts?: number;
  delayMs?: number;
  /** What is being done, for the line printed when a retry happens. */
  label?: string;
}

export async function retryTransient<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 6;
  const delayMs = options.delayMs ?? 15;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= attempts || code === undefined || !TRANSIENT_FS_ERRORS.has(code)) throw error;
      // Visible on purpose: if this prints, a file WAS contended and the retry saved an operation that used to fail silently.
      process.stderr.write(`[fs] ${code} on ${options.label ?? 'a file'}, retry ${attempt}/${attempts - 1}\n`);
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}

export function readFileRetry(file: string): Promise<Buffer>;
export function readFileRetry(file: string, encoding: BufferEncoding): Promise<string>;
export function readFileRetry(file: string, encoding?: BufferEncoding): Promise<Buffer | string> {
  const read = (): Promise<Buffer | string> => (encoding ? fs.readFile(file, encoding) : fs.readFile(file));
  return retryTransient(read, { label: path.basename(file) });
}
