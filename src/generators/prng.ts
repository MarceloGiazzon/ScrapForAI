import { createHash } from 'node:crypto';

/**
 * A small deterministic PRNG for reproducible test data (T5.3). Not for secrets: its only job is that the same seed always gives
 * the same values, on any machine, so a failing sample can be replayed. Seeds are strings; the stream is mulberry32 over the first
 * 32 bits of sha256(seed).
 */
export type Rng = () => number;

export function createRng(seed: string): Rng {
  let state = createHash('sha256').update(seed).digest().readUInt32BE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform integer in [min, max], both included. */
export function intBetween(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[intBetween(rng, 0, items.length - 1)]!;
}
