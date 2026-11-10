/**
 * T5.2 benchmark: runs saved routines N times under `full` and `functional` through the CLI of a RUNNING server, checks that the
 * step outcomes never differ between profiles (the acceptance criterion) and prints the timings as a markdown table to paste into
 * docs/. The speed-up is measured, not promised: against a local server it can be small.
 *
 *   npm run bench:profile -- <routineId> [<routineId>...] [--runs 10] [--target id] [--credential set] [--url http://host:port]
 *
 * `--url` points the CLI at another ScrapForAI server than the one in .env (the API key still comes from .env), e.g. a scratch server started on
 * another port with its own data directory, so a benchmark against a throttled fixture touches nothing of the real installation.
 *
 * Needs the server running and the routines saved. Runs against a real application: use a dev/QA target, and routines that are
 * safe to repeat (a routine that creates data will create it 2 x N times; give it a teardown).
 */
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { runs: { type: 'string' }, target: { type: 'string' }, credential: { type: 'string' }, url: { type: 'string' } } });
const runs = Number(values.runs ?? '10');
if (positionals.length === 0 || !Number.isInteger(runs) || runs < 1) {
  console.error('usage: npm run bench:profile -- <routineId>... [--runs N] [--target id] [--credential set] [--url http://host:port]');
  process.exit(2);
}

interface Sample {
  profile: 'full' | 'functional';
  ms: number;
  verdict: string;
  steps: string;
}

function runOnce(routineId: string, profile: 'full' | 'functional'): Sample {
  const args = ['tsx', 'src/cli.ts', 'run', routineId, '--profile', profile, '--json'];
  if (values.target) args.push('--target', values.target);
  if (values.credential) args.push('--credential', values.credential);
  if (values.url) args.push('--url', values.url);
  const proc = spawnSync('npx', args, { encoding: 'utf8', shell: process.platform === 'win32' });
  const line = proc.stdout.trim().split('\n').at(-1) ?? '';
  const out = JSON.parse(line) as { exitCode: number; result?: { durationMs: number; status: string; steps: { total: number; passed: number; failed: number }; failedStepIndex?: number } };
  if (!out.result) throw new Error(`run of "${routineId}" could not execute: ${line.slice(0, 300)}`);
  const { result } = out;
  return { profile, ms: result.durationMs, verdict: result.status, steps: `${result.steps.passed}/${result.steps.total} passed, failedStepIndex=${result.failedStepIndex ?? '-'}` };
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
};

let mismatch = false;
const rows: string[] = [];
for (const routineId of positionals) {
  const samples: Sample[] = [];
  for (let i = 0; i < runs; i += 1) {
    // alternate the order so a warm cache or a slow minute does not always favour one profile
    const order: Array<'full' | 'functional'> = i % 2 === 0 ? ['full', 'functional'] : ['functional', 'full'];
    for (const profile of order) samples.push(runOnce(routineId, profile));
  }
  const of = (profile: 'full' | 'functional') => samples.filter((s) => s.profile === profile);
  const outcomes = new Set(samples.map((s) => `${s.verdict}|${s.steps}`));
  if (outcomes.size > 1) mismatch = true;
  const full = median(of('full').map((s) => s.ms));
  const functional = median(of('functional').map((s) => s.ms));
  rows.push(
    `| ${routineId} | ${runs} | ${Math.round(full)} | ${Math.round(functional)} | ${(((full - functional) / full) * 100).toFixed(1)}% | ${outcomes.size === 1 ? 'identical' : `DIFFERENT: ${[...outcomes].join(' / ')}`} |`,
  );
}

console.log('| routine | runs per profile | full median (ms) | functional median (ms) | saved | step outcomes |');
console.log('|---|---|---|---|---|---|');
for (const row of rows) console.log(row);
if (mismatch) {
  console.error('\nA step outcome differed between profiles: the acceptance criterion is NOT met for at least one routine.');
  process.exit(1);
}
