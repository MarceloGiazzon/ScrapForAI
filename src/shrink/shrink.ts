/**
 * T5.6: from "this sample fails" to "THIS is the smallest input that still fails". Pure: the caller supplies `probe`, which runs the
 * scenario with exact parameter values and says whether it failed THE SAME WAY (same step, same error type: a smaller input that fails
 * somewhere else is a different bug and must not be taken for progress).
 *
 *   1. confirm       the failing values fail again (else the failure is not reproducible and nothing is shrunk).
 *   2. ddmin         which parameters matter? Every parameter that can be reset to a neutral baseline is reset; delta debugging
 *                    (Zeller's ddmin) finds a minimal subset that must keep its failing value.
 *   3. per value     numeric: binary search between the baseline (passes) and the failing value, down to two ADJACENT values, one that
 *                    fails and one that does not; string: cut in half, then drop one character at a time.
 *
 * Invariant: `current` is always a configuration a real run FAILED with. Every claim in the result ("fails with qty=1000, passes with
 * qty=999") was observed, never inferred. Binary search assumes the failing region is one interval; with several, it still returns an
 * adjacent pair that flips, which is a true boundary but not necessarily the only one.
 */

export type ParameterKind =
  | { kind: 'int'; baseline: string }
  | { kind: 'decimal'; scale: number; baseline: string }
  | { kind: 'string'; baseline: string }
  /** A value picked from a list, a date, a document: it can be reset to its baseline but has no "smaller". */
  | { kind: 'opaque'; baseline: string }
  /** Nothing neutral to reset it to: it stays as it failed. */
  | { kind: 'fixed' };

export interface ShrinkParameter {
  name: string;
  shape: ParameterKind;
}

export interface ProbeOutcome {
  /** Failed the same way as the original failure. */
  fails: boolean;
  jobId?: string;
}

export type Probe = (values: Record<string, string>) => Promise<ProbeOutcome>;

export interface ShrinkInput {
  parameters: ShrinkParameter[];
  /** The values of the failing sample. */
  failing: Record<string, string>;
  probe: Probe;
  maxRuns: number;
  /** Epoch ms after which no new probe starts. */
  deadline: number;
  signal?: AbortSignal;
  /** Called after every real run, so a long search can report where it is. */
  onProgress?: (progress: { runs: number; trail: ShrinkTrailEntry[]; current: Record<string, string> }) => void;
}

export interface Boundary {
  parameter: string;
  /** The smallest value (in the direction of the search) that was seen to fail. */
  fails: string;
  /** The adjacent value that does not fail the same way. */
  passes: string;
  /** `adjacent`: the two are neighbours (exact limit); `bracket`: the budget ended with the limit still between them. */
  precision: 'adjacent' | 'bracket';
}

export interface ShrinkTrailEntry {
  run: number;
  what: string;
  failed: boolean;
  jobId?: string;
}

export type ShrinkStatus =
  | 'minimal'
  /** Nothing about the parameters matters: the failure happens with every parameter at its baseline. */
  | 'independent'
  | 'not-reproduced'
  | 'budget'
  | 'timeout'
  | 'cancelled'
  | 'error';

export interface ShrinkResult {
  status: ShrinkStatus;
  failing: Record<string, string>;
  /** The smallest configuration found; a run failed with exactly these values (see `minimalJobId`). */
  minimal: Record<string, string>;
  minimalJobId?: string;
  /** Parameters whose minimal value differs from their baseline: the ones the failure needs. */
  essential: string[];
  boundaries: Boundary[];
  runs: number;
  trail: ShrinkTrailEntry[];
  error?: string;
}

class Stop extends Error {
  constructor(readonly why: 'budget' | 'timeout' | 'cancelled') {
    super(why);
  }
}

const show = (values: Record<string, string>, names: string[]): string => names.map((name) => `${name}=${JSON.stringify(values[name])}`).join(' ');

/** Integer units of a numeric parameter: the value itself (int) or the value times 10^scale (decimal), rounded. */
const toUnits = (text: string, scale: number): number => Math.round(Number(text) * 10 ** scale);
const fromUnits = (units: number, scale: number): string => (scale === 0 ? String(units) : (units / 10 ** scale).toFixed(scale));

export async function shrink(input: ShrinkInput): Promise<ShrinkResult> {
  const trail: ShrinkTrailEntry[] = [];
  const cache = new Map<string, ProbeOutcome>();
  const boundaries: Boundary[] = [];
  let runs = 0;
  let current: Record<string, string> = { ...input.failing };
  let currentJobId: string | undefined;

  const finish = (status: ShrinkStatus, error?: string): ShrinkResult => {
    const essential = input.parameters
      .filter((parameter) => parameter.shape.kind !== 'fixed' && 'baseline' in parameter.shape && current[parameter.name] !== parameter.shape.baseline)
      .map((parameter) => parameter.name);
    return {
      status,
      failing: input.failing,
      minimal: current,
      ...(currentJobId ? { minimalJobId: currentJobId } : {}),
      essential,
      boundaries,
      runs,
      trail,
      ...(error ? { error } : {}),
    };
  };

  /** Runs the scenario with `values`; true when it fails the same way. Never runs the same values twice. */
  const fails = async (values: Record<string, string>, what: string): Promise<boolean> => {
    const key = JSON.stringify(Object.keys(values).sort().map((name) => [name, values[name]]));
    const known = cache.get(key);
    if (known) {
      if (known.fails) {
        current = { ...values };
        currentJobId = known.jobId;
      }
      return known.fails;
    }
    if (input.signal?.aborted) throw new Stop('cancelled');
    if (runs >= input.maxRuns) throw new Stop('budget');
    if (Date.now() >= input.deadline) throw new Stop('timeout');

    runs += 1;
    const outcome = await input.probe(values);
    cache.set(key, outcome);
    trail.push({ run: runs, what, failed: outcome.fails, ...(outcome.jobId ? { jobId: outcome.jobId } : {}) });
    if (outcome.fails) {
      current = { ...values };
      currentJobId = outcome.jobId;
    }
    input.onProgress?.({ runs, trail, current });
    return outcome.fails;
  };

  const withValue = (name: string, value: string): Record<string, string> => ({ ...current, [name]: value });
  const baselineOf = (parameter: ShrinkParameter): string | undefined => ('baseline' in parameter.shape ? parameter.shape.baseline : undefined);

  try {
    // 1. The failure must repeat with the same inputs.
    if (!(await fails(current, 'confirm the failing values'))) return finish('not-reproduced');

    // 2. Which parameters matter? Reset the ones that can be reset (ddmin over them).
    const movable = input.parameters.filter((parameter) => baselineOf(parameter) !== undefined && current[parameter.name] !== baselineOf(parameter));
    const configWith = (kept: ShrinkParameter[]): Record<string, string> => {
      const values = { ...current };
      for (const parameter of movable) if (!kept.includes(parameter)) values[parameter.name] = baselineOf(parameter)!;
      return values;
    };

    let essential: ShrinkParameter[] = movable;
    if (movable.length > 0) {
      const resetAll = configWith([]);
      if (await fails(resetAll, `reset ${movable.map((parameter) => parameter.name).join(', ')} to their baselines`)) return finish('independent');

      let kept = movable;
      let n = 2;
      while (kept.length >= 2) {
        const size = Math.ceil(kept.length / n);
        const chunks: ShrinkParameter[][] = [];
        for (let i = 0; i < kept.length; i += size) chunks.push(kept.slice(i, i + size));

        let reduced = false;
        for (const chunk of chunks) {
          if (await fails(configWith(chunk), `keep only ${chunk.map((parameter) => parameter.name).join(', ')}`)) {
            kept = chunk;
            n = 2;
            reduced = true;
            break;
          }
        }
        if (!reduced) {
          for (const chunk of chunks) {
            const complement = kept.filter((parameter) => !chunk.includes(parameter));
            if (complement.length === 0 || complement.length === kept.length) continue;
            if (await fails(configWith(complement), `drop ${chunk.map((parameter) => parameter.name).join(', ')}`)) {
              kept = complement;
              n = Math.max(n - 1, 2);
              reduced = true;
              break;
            }
          }
        }
        if (!reduced) {
          if (n >= kept.length) break;
          n = Math.min(kept.length, n * 2);
        }
      }
      essential = kept;
    }

    // 3. Shrink the value of each parameter that matters.
    for (const parameter of essential) {
      const { shape } = parameter;
      if (shape.kind === 'int' || shape.kind === 'decimal') {
        const scale = shape.kind === 'decimal' ? shape.scale : 0;
        const good = toUnits(shape.baseline, scale);
        let bad = toUnits(current[parameter.name]!, scale);
        if (good === bad) continue;

        if (await fails(withValue(parameter.name, shape.baseline), `${parameter.name}=${shape.baseline} (neutral value)`)) continue;

        let lo = good; // does not fail
        try {
          while (Math.abs(bad - lo) > 1) {
            const mid = lo + Math.trunc((bad - lo) / 2);
            const value = fromUnits(mid, scale);
            if (await fails(withValue(parameter.name, value), `${parameter.name}=${value}`)) bad = mid;
            else lo = mid;
          }
        } catch (error) {
          // Cut short: the limit is somewhere between the last value that passed and the last that failed.
          if (error instanceof Stop) boundaries.push({ parameter: parameter.name, fails: fromUnits(bad, scale), passes: fromUnits(lo, scale), precision: 'bracket' });
          throw error;
        }
        boundaries.push({ parameter: parameter.name, fails: fromUnits(bad, scale), passes: fromUnits(lo, scale), precision: 'adjacent' });
      } else if (shape.kind === 'string') {
        if (current[parameter.name] === shape.baseline) continue;
        if (await fails(withValue(parameter.name, shape.baseline), `${parameter.name} = neutral text`)) continue;

        let chars = Array.from(current[parameter.name]!);
        const attempt = async (candidate: string[], what: string): Promise<boolean> => {
          if (candidate.length === chars.length) return false;
          if (await fails(withValue(parameter.name, candidate.join('')), `${parameter.name}: ${what} (${candidate.length} characters)`)) {
            chars = candidate;
            return true;
          }
          return false;
        };

        // Halves first: a long text drops to the failing part in about log2(n) runs.
        while (chars.length > 1) {
          const half = Math.floor(chars.length / 2);
          if (await attempt(chars.slice(0, half), 'first half')) continue;
          if (await attempt(chars.slice(half), 'second half')) continue;
          break;
        }
        // Then one character at a time.
        for (let i = 0; i < chars.length && chars.length > 1; ) {
          if (await attempt([...chars.slice(0, i), ...chars.slice(i + 1)], `without character ${i + 1}`)) continue;
          i += 1;
        }
      }
    }

    return finish('minimal');
  } catch (error) {
    if (error instanceof Stop) {
      // The search was cut short: the bracket of every numeric boundary still open is reported as such.
      return finish(error.why);
    }
    return finish('error', error instanceof Error ? error.message : String(error));
  }
}

/** Describes the result in one line a person can act on. */
export function summarizeShrink(result: ShrinkResult): string {
  const names = Object.keys(result.minimal);
  switch (result.status) {
    case 'not-reproduced':
      return `the failure did not repeat with the same values (${show(result.failing, names)}): it is not deterministic, nothing was shrunk`;
    case 'independent':
      return `it fails with every parameter at its neutral value (${show(result.minimal, names)}): the parameters are not what breaks it`;
    default: {
      const parts = [`fails with ${show(result.minimal, result.essential.length > 0 ? result.essential : names)}`];
      for (const boundary of result.boundaries) parts.push(`${boundary.precision === 'adjacent' ? 'passes' : 'passes somewhere up to'} with ${boundary.parameter}=${boundary.passes}`);
      const partial = result.status === 'budget' || result.status === 'timeout' || result.status === 'cancelled' || result.status === 'error';
      return `${parts.join(', ')}${partial ? ` (stopped early: ${result.status}${result.error ? ` - ${result.error}` : ''}; not necessarily minimal)` : ''} - ${result.runs} run(s)`;
    }
  }
}
