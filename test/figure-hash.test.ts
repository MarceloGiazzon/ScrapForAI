import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

import { figureChangesFixture } from './helpers/figureChangesFixture.js';
import { CELL_DELTA, compareFigures, describeFigure, FINGERPRINT_GRID, fingerprintPng, pngSize, toBase64, UnsupportedPngError } from '../src/manual/figureHash.js';

// T9.2: the simple perceptual hash. PNGs are built here (the decoder does not check CRCs, so the chunks carry zeros) so the rules are tested without a browser.

type Pixel = [number, number, number, number];

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Filters a scanline the way an encoder does (type 0-4). */
function filterRow(type: number, row: Uint8Array, previous: Uint8Array, bpp: number): Buffer {
  const out = Buffer.alloc(row.length + 1);
  out[0] = type;
  for (let i = 0; i < row.length; i += 1) {
    const left = i >= bpp ? row[i - bpp]! : 0;
    const up = previous[i]!;
    const upLeft = i >= bpp ? previous[i - bpp]! : 0;
    const predictor = type === 0 ? 0 : type === 1 ? left : type === 2 ? up : type === 3 ? (left + up) >> 1 : paeth(left, up, upLeft);
    out[i + 1] = (row[i]! - predictor) & 0xff;
  }
  return out;
}

function encodePng(width: number, height: number, pixel: (x: number, y: number) => Pixel, options: { colorType?: 2 | 6; filter?: (y: number) => number } = {}): Buffer {
  const colorType = options.colorType ?? 6;
  const channels = colorType === 6 ? 4 : 3;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colorType;
  const rows: Buffer[] = [];
  let previous: Uint8Array = new Uint8Array(width * channels);
  for (let y = 0; y < height; y += 1) {
    const row = new Uint8Array(width * channels);
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixel(x, y);
      row[x * channels] = r;
      row[x * channels + 1] = g;
      row[x * channels + 2] = b;
      if (channels === 4) row[x * channels + 3] = a;
    }
    rows.push(filterRow(options.filter?.(y) ?? 0, row, previous, channels));
    previous = row;
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

const WHITE: Pixel = [255, 255, 255, 255];
const BLACK: Pixel = [0, 0, 0, 255];

/** A "page": white with dark blocks where `blocks` says (x0, y0, x1, y1). */
function page(blocks: Array<[number, number, number, number]>, size: [number, number] = [320, 200]) {
  return encodePng(size[0], size[1], (x, y) => (blocks.some(([x0, y0, x1, y1]) => x >= x0 && x < x1 && y >= y0 && y < y1) ? BLACK : WHITE));
}

test('a solid image fingerprints to its luminance, in a 32x32 grid', () => {
  const white = fingerprintPng(encodePng(64, 48, () => WHITE));
  const black = fingerprintPng(encodePng(64, 48, () => BLACK));
  assert.equal(white.grid.length, FINGERPRINT_GRID * FINGERPRINT_GRID);
  assert.ok([...white.grid].every((value) => value === 255));
  assert.ok([...black.grid].every((value) => value === 0));
  assert.deepEqual([white.width, white.height], [64, 48]);
});

test('every PNG filter decodes to the same picture', () => {
  const picture = (x: number, y: number): Pixel => [(x * 7 + y * 3) % 256, (x * 5) % 256, (y * 11) % 256, 255];
  const reference = toBase64(fingerprintPng(encodePng(50, 40, picture, { filter: () => 0 })).grid);
  for (const type of [1, 2, 3, 4]) {
    assert.equal(toBase64(fingerprintPng(encodePng(50, 40, picture, { filter: () => type })).grid), reference, `filter ${type}`);
  }
  assert.equal(toBase64(fingerprintPng(encodePng(50, 40, picture, { filter: (y) => y % 5 })).grid), reference, 'a different filter on every row');
});

test('RGB and RGBA decode alike, and transparency counts as white paper', () => {
  const rgb = fingerprintPng(encodePng(40, 40, () => [10, 20, 30, 255], { colorType: 2 }));
  const rgba = fingerprintPng(encodePng(40, 40, () => [10, 20, 30, 255], { colorType: 6 }));
  assert.deepEqual([...rgb.grid], [...rgba.grid]);
  const clear = fingerprintPng(encodePng(40, 40, () => [0, 0, 0, 0]));
  assert.ok([...clear.grid].every((value) => value === 255), 'a fully transparent pixel is paper, whatever its colour');
});

test('an image smaller than the grid still fingerprints (cells without pixels take the one before)', () => {
  const tiny = fingerprintPng(encodePng(3, 2, () => BLACK));
  assert.ok([...tiny.grid].every((value) => value === 0));
});

test('what is not a supported PNG is refused with a clear error, never guessed', () => {
  assert.throws(() => fingerprintPng(Buffer.from('not a png at all, but long enough to be looked at 12345')), UnsupportedPngError);
  const interlaced = encodePng(4, 4, () => WHITE);
  interlaced[8 + 8 + 12] = 1; // IHDR interlace byte
  assert.throws(() => fingerprintPng(interlaced), /interlaced/);
  assert.equal(pngSize(Buffer.from('nope')), undefined);
  assert.deepEqual(pngSize(encodePng(7, 9, () => WHITE)), { width: 7, height: 9 });
});

test('the same bytes are unchanged', () => {
  const a = describeFigure(page([[20, 20, 120, 40]]));
  assert.deepEqual(compareFigures(a, { ...a }), { verdict: 'unchanged' });
});

test('a block that moved is a visual change, with how much of the picture it touched', () => {
  const before = describeFigure(page([[20, 20, 120, 40]]));
  const after = describeFigure(page([[20, 120, 120, 140]]));
  const result = compareFigures(before, after);
  assert.equal(result.verdict, 'changed');
  assert.equal(result.reason, 'visual');
  assert.ok((result.changedCells ?? 0) > 0 && (result.percent ?? 0) > 0);
  assert.equal(result.totalCells, FINGERPRINT_GRID * FINGERPRINT_GRID);
});

test('one pixel of noise is negligible: the bytes differ, no cell moved', () => {
  const base = (x: number, y: number): Pixel => (x >= 20 && x < 120 && y >= 20 && y < 40 ? BLACK : WHITE);
  const before = describeFigure(encodePng(320, 200, base));
  const after = describeFigure(encodePng(320, 200, (x, y) => (x === 300 && y === 190 ? [200, 200, 200, 255] : base(x, y))));
  assert.notEqual(before.sha256, after.sha256);
  const result = compareFigures(before, after);
  assert.equal(result.verdict, 'negligible');
  assert.equal(result.changedCells, 0);
});

test('a bigger or smaller picture is changed because of its size', () => {
  const result = compareFigures(describeFigure(page([], [320, 200])), describeFigure(page([], [320, 240])));
  assert.deepEqual(result, { verdict: 'changed', reason: 'resized' });
});

test('a figure that cannot be decoded is compared by its bytes, and a difference is a change', () => {
  const a = describeFigure(Buffer.from('first file that is not a png'));
  const b = describeFigure(Buffer.from('second file that is not a png'));
  assert.equal(a.fingerprint, undefined);
  assert.deepEqual(compareFigures(a, b), { verdict: 'changed', reason: 'bytes' });
  assert.equal(compareFigures(a, { ...a }).verdict, 'unchanged');
});

test('the threshold is a few levels of luminance, not one', () => {
  assert.ok(CELL_DELTA >= 2 && CELL_DELTA <= 16);
  // A whole picture a few levels darker (e.g. another anti-aliasing mode) stays under the threshold; a clear step does not.
  const grey = (level: number) => describeFigure(encodePng(64, 64, () => [level, level, level, 255]));
  assert.equal(compareFigures(grey(250), grey(250 - (CELL_DELTA - 1))).verdict, 'negligible');
  assert.equal(compareFigures(grey(250), grey(250 - CELL_DELTA)).verdict, 'changed');
});

test('diffFigures keys by figure id: adding a step before another does not make the later ones new', async () => {
  const { diffFigures } = await import('../src/manual/figureChanges.js');
  const fixture = figureChangesFixture(describeFigure);
  const result = diffFigures(fixture.previous, fixture.current);
  assert.deepEqual(result.new, ['b/inserted']);
  assert.deepEqual(result.removed, ['b/gone']);
  assert.deepEqual(result.changed.map((change) => change.id), ['a/moved']);
  assert.deepEqual(result.negligible, []);
  assert.equal(result.unchanged, 1);
  assert.equal(result.firstBuild, false);
  assert.equal(result.previousBuildId, 'rev1');
  assert.equal(diffFigures(undefined, fixture.current).firstBuild, true);
  assert.deepEqual(diffFigures(undefined, fixture.current).new.length, fixture.current.length);
});
