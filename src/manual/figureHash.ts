import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

/**
 * T9.2: "which figures changed since the last build?" without a dependency.
 *
 * A figure is described by its sha256 (any difference at all) and by a SIMPLE PERCEPTUAL FINGERPRINT: the page reduced to a 32x32 grid of mean
 * luminance (area average of the grey-scale image). Two screenshots of the same page rendered twice differ by a few bytes (anti-aliasing, a caret, a
 * timestamp); those leave the grid within a few levels. A different label, a new button or a moved block changes the cells it covers by much more.
 * The PNG is decoded here (zlib is built into Node): Playwright produces 8-bit, non-interlaced PNGs, and anything else is reported as unsupported,
 * in which case the figure is compared by sha256 alone (stricter, never wrong).
 *
 * Limits, on purpose: this is a review aid, not an image-diff product. A change of one character in a long line can stay under the threshold
 * (the figure is then listed as "differs only slightly", never as unchanged); a shift of a few pixels is the same. PURE: no configuration, no I/O.
 */

/** The grid is GRID x GRID cells. */
export const FINGERPRINT_GRID = 32;
/** A cell counts as changed when its mean luminance moved by at least this much (of 255). */
export const CELL_DELTA = 6;

export class UnsupportedPngError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedPngError';
  }
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export interface Fingerprint {
  width: number;
  height: number;
  /** GRID*GRID mean luminance values, row by row. */
  grid: Uint8Array;
}

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Width and height of a PNG from its header, or undefined if it is not one. */
export function pngSize(png: Buffer): { width: number; height: number } | undefined {
  if (png.length < 24 || !png.subarray(0, 8).equals(SIGNATURE) || png.toString('latin1', 12, 16) !== 'IHDR') return undefined;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** Decodes a PNG and reduces it to the fingerprint grid, one scanline at a time (a full-page figure is never held as a whole). */
export function fingerprintPng(png: Buffer): Fingerprint {
  if (png.length < 33 || !png.subarray(0, 8).equals(SIGNATURE)) throw new UnsupportedPngError('not a PNG file');

  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = -1;
  let interlace = 0;
  const idat: Buffer[] = [];
  let palette: Buffer | undefined;

  let offset = 8;
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > png.length) throw new UnsupportedPngError('truncated PNG');
    if (type === 'IHDR') {
      width = png.readUInt32BE(start);
      height = png.readUInt32BE(start + 4);
      depth = png[start + 8]!;
      colorType = png[start + 9]!;
      interlace = png[start + 12]!;
    } else if (type === 'PLTE') {
      palette = png.subarray(start, end);
    } else if (type === 'IDAT') {
      idat.push(png.subarray(start, end));
    } else if (type === 'IEND') {
      break;
    }
    offset = end + 4;
  }

  if (width < 1 || height < 1) throw new UnsupportedPngError('no image header');
  if (interlace !== 0) throw new UnsupportedPngError('interlaced PNG');
  const channels = CHANNELS[colorType];
  if (channels === undefined) throw new UnsupportedPngError(`colour type ${colorType}`);
  if (depth !== 8 && !(depth === 16 && colorType !== 3)) throw new UnsupportedPngError(`bit depth ${depth}`);
  if (colorType === 3 && !palette) throw new UnsupportedPngError('palette image without a palette');
  if (width * height > 200_000_000) throw new UnsupportedPngError('image too large');

  const bytesPerPixel = (channels * depth) / 8;
  const stride = width * bytesPerPixel;
  const expected = (stride + 1) * height;
  let raw: Buffer;
  try {
    // Never more than the header promises: a file that inflates to more is not a screenshot of ours.
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
  } catch {
    throw new UnsupportedPngError('image data does not inflate to what the header says');
  }
  if (raw.length < expected) throw new UnsupportedPngError('image data is shorter than the header says');

  const sums = new Float64Array(FINGERPRINT_GRID * FINGERPRINT_GRID);
  const counts = new Uint32Array(FINGERPRINT_GRID * FINGERPRINT_GRID);
  let previous = new Uint8Array(stride);
  let current = new Uint8Array(stride);
  const sample = depth === 16 ? 2 : 1; // bytes per sample; the high byte is enough for a luminance

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart]!;
    for (let i = 0; i < stride; i += 1) {
      const x = raw[rowStart + 1 + i]!;
      const left = i >= bytesPerPixel ? current[i - bytesPerPixel]! : 0;
      const up = previous[i]!;
      const upLeft = i >= bytesPerPixel ? previous[i - bytesPerPixel]! : 0;
      let value: number;
      switch (filter) {
        case 0: value = x; break;
        case 1: value = x + left; break;
        case 2: value = x + up; break;
        case 3: value = x + ((left + up) >> 1); break;
        case 4: value = x + paeth(left, up, upLeft); break;
        default: throw new UnsupportedPngError(`filter type ${filter}`);
      }
      current[i] = value & 0xff;
    }

    const cellRow = Math.min(FINGERPRINT_GRID - 1, Math.floor((y * FINGERPRINT_GRID) / height)) * FINGERPRINT_GRID;
    for (let px = 0; px < width; px += 1) {
      const base = px * bytesPerPixel;
      let luminance: number;
      let alpha = 255;
      if (colorType === 0) {
        luminance = current[base]!;
      } else if (colorType === 4) {
        luminance = current[base]!;
        alpha = current[base + sample]!;
      } else if (colorType === 3) {
        const entry = current[base]! * 3;
        luminance = 0.299 * (palette![entry] ?? 0) + 0.587 * (palette![entry + 1] ?? 0) + 0.114 * (palette![entry + 2] ?? 0);
      } else {
        luminance = 0.299 * current[base]! + 0.587 * current[base + sample]! + 0.114 * current[base + 2 * sample]!;
        if (colorType === 6) alpha = current[base + 3 * sample]!;
      }
      // Over white, like a page: a transparent pixel is paper.
      if (alpha < 255) luminance = (luminance * alpha + 255 * (255 - alpha)) / 255;
      const cell = cellRow + Math.min(FINGERPRINT_GRID - 1, Math.floor((px * FINGERPRINT_GRID) / width));
      sums[cell]! += luminance;
      counts[cell]! += 1;
    }
    [previous, current] = [current, previous];
  }

  const grid = new Uint8Array(FINGERPRINT_GRID * FINGERPRINT_GRID);
  for (let cell = 0; cell < grid.length; cell += 1) {
    if (counts[cell]! > 0) {
      grid[cell] = Math.round(sums[cell]! / counts[cell]!);
    } else {
      // An image smaller than the grid leaves cells without pixels: they take the cell before them.
      grid[cell] = cell > 0 ? grid[cell - 1]! : 255;
    }
  }
  return { width, height, grid };
}

export const toBase64 = (grid: Uint8Array): string => Buffer.from(grid).toString('base64');

export function fromBase64(text: string): Uint8Array | undefined {
  const bytes = new Uint8Array(Buffer.from(text, 'base64'));
  return bytes.length === FINGERPRINT_GRID * FINGERPRINT_GRID ? bytes : undefined;
}

export interface FigureDescription {
  sha256: string;
  width: number;
  height: number;
  /** base64 of the grid; absent when the PNG could not be decoded. */
  fingerprint?: string;
}

/** Everything the manifest keeps about one figure file. Never throws: an undecodable PNG is described by its hash alone. */
export function describeFigure(png: Buffer): FigureDescription {
  const sha256 = createHash('sha256').update(png).digest('hex');
  try {
    const print = fingerprintPng(png);
    return { sha256, width: print.width, height: print.height, fingerprint: toBase64(print.grid) };
  } catch {
    const size = pngSize(png);
    return { sha256, width: size?.width ?? 0, height: size?.height ?? 0 };
  }
}

export type FigureVerdict = 'unchanged' | 'negligible' | 'changed';

export interface FigureComparison {
  verdict: FigureVerdict;
  /** Why it is `changed`: the size is different, the picture is, or only the bytes are (a figure that cannot be compared visually). */
  reason?: 'resized' | 'visual' | 'bytes';
  changedCells?: number;
  totalCells?: number;
  /** Share of the picture that changed, 0-100, one decimal. */
  percent?: number;
}

/**
 * `unchanged`: the same bytes. `negligible`: the bytes differ but no cell of the grid moved by CELL_DELTA (rendering noise, most likely).
 * `changed`: another size, or at least one cell moved by CELL_DELTA or more -- or the bytes differ and a fingerprint is missing on either side.
 */
export function compareFigures(before: FigureDescription, after: FigureDescription): FigureComparison {
  if (before.sha256 === after.sha256) return { verdict: 'unchanged' };
  if (before.width !== after.width || before.height !== after.height) return { verdict: 'changed', reason: 'resized' };

  const a = before.fingerprint === undefined ? undefined : fromBase64(before.fingerprint);
  const b = after.fingerprint === undefined ? undefined : fromBase64(after.fingerprint);
  if (!a || !b) return { verdict: 'changed', reason: 'bytes' };

  let changedCells = 0;
  for (let cell = 0; cell < a.length; cell += 1) {
    if (Math.abs(a[cell]! - b[cell]!) >= CELL_DELTA) changedCells += 1;
  }
  const totalCells = a.length;
  const percent = Math.round((changedCells / totalCells) * 1000) / 10;
  return changedCells > 0 ? { verdict: 'changed', reason: 'visual', changedCells, totalCells, percent } : { verdict: 'negligible', changedCells: 0, totalCells, percent: 0 };
}
