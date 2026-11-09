// `npm install` runs this ("prepare"): point git at the versioned hooks in .githooks/ (the commit guard, scripts/secret-scan.ts).
// Plain node, no dependency: it also runs where devDependencies are not installed. Outside a git work tree (a ZIP, the installer, Docker) it does nothing.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import path from 'node:path';

const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
if (inside.status !== 0 || inside.stdout.trim() !== 'true') process.exit(0);
const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();
if (!existsSync(path.join(root, '.githooks', 'pre-commit'))) process.exit(0);

const current = spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8' }).stdout.trim();
if (current && current !== '.githooks') {
  console.warn(`[hooks] core.hooksPath is already "${current}": left alone. The secret guard is NOT active; see .githooks/.`);
  process.exit(0);
}
spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root });
for (const hook of ['pre-commit', 'commit-msg', 'pre-push']) {
  try {
    chmodSync(path.join(root, '.githooks', hook), 0o755);
  } catch {
    // Windows: git for Windows runs the hook through sh whatever the mode.
  }
}
if (!current) console.log('[hooks] secret guard active (core.hooksPath=.githooks): pre-commit, commit-msg, pre-push');
