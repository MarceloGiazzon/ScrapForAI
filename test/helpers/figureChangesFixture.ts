import { deflateSync } from 'node:zlib';

import type { FigureDescription } from '../../src/manual/figureHash.js';
import type { ManualFigure } from '../../src/schemas/manual.schema.js';

/** Small PNGs and manifest figures for the figure-diff tests (the decoder does not check CRCs, so the chunks carry zeros). */

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}

/** A white picture with one dark block. */
export function blockPng(width: number, height: number, block: [number, number, number, number] | undefined): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3, 255);
    row[0] = 0;
    for (let x = 0; x < width; x += 1) {
      if (block && x >= block[0] && x < block[2] && y >= block[1] && y < block[3]) row.fill(0, 1 + x * 3, 1 + x * 3 + 3);
    }
    rows.push(row);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

export function figureOf(id: string, description: FigureDescription): ManualFigure {
  const [routineId, stepId] = id.split('/') as [string, string];
  return { id, routineId, stepId, file: `figures/${routineId}/${stepId}.png`, ...description };
}

/** previous: a/same, a/moved, b/gone. current: a/same, a/moved (the block moved), b/inserted. */
export function figureChangesFixture(describe: (png: Buffer) => FigureDescription) {
  const same = describe(blockPng(160, 100, [10, 10, 80, 30]));
  const before = describe(blockPng(160, 100, [10, 10, 80, 30]));
  const moved = describe(blockPng(160, 100, [10, 60, 80, 80]));
  const gone = describe(blockPng(160, 100, undefined));
  return {
    previous: { buildId: 'rev1', createdAt: '2026-11-01T00:00:00.000Z', figures: [figureOf('a/same', same), figureOf('a/moved', before), figureOf('b/gone', gone)] },
    current: [figureOf('a/same', same), figureOf('a/moved', moved), figureOf('b/inserted', gone)],
  };
}
