import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Best effort: restrict a secret file (vault key, signing key) to the current user. On POSIX the 0o600
 * mode given at creation already applies; on Windows inherited ACEs are dropped and only the user keeps
 * access. A failure (e.g. a FAT volume) is not fatal.
 */
export async function restrictToCurrentUser(file: string): Promise<void> {
  if (process.platform !== 'win32') {
    return;
  }

  const user = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${os.userInfo().username}` : os.userInfo().username;
  await execFileAsync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`]).catch(() => undefined);
}
