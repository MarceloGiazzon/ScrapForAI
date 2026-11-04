import { sha256Of, TRUSTED_SCRIPTS } from '../src/runner/trusted/registry.js';

// Prints the sha256 of every trusted script's current source (T7.1), to paste into src/runner/trusted/registry.ts after a REVIEWED change.
for (const script of TRUSTED_SCRIPTS) {
  const actual = sha256Of(script.source);
  console.log(`${script.id.padEnd(24)} ${actual}${actual === script.sha256 ? '  (pinned)' : '  (NOT the pinned value)'}`);
}
