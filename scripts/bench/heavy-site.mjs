// A page with many large images, served through ONE shared link (token bucket) with latency, to measure what the `functional` profile saves when the
// images are expensive. The link is a SIMULATION: its numbers are the ones given to /__mode, not a measurement of any real network.
//   GET /__mode?latency=60&mbps=5   set the link (omit both for an unthrottled local link)
//   GET /__stats[?reset=1]          how many requests of each kind were served
import http from 'node:http';
import zlib from 'node:zlib';

const PORT = Number(process.env.FIXTURE_PORT ?? 8190);
const IMAGES = 30;
const W = 400;
const H = 300;
const CHUNK = 16 * 1024;

function crc32(buffer) {
  return zlib.crc32(buffer) >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function noisePng(seed) {
  // 8-bit RGB, filter 0, random pixels: does not compress, so the file is about W*H*3 bytes (~360 KB).
  let state = seed * 2654435761 >>> 0;
  const next = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) >>> 24);
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y += 1) {
    const row = y * (1 + W * 3);
    raw[row] = 0;
    for (let i = 1; i <= W * 3; i += 1) raw[row + i] = next();
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
}
const pictures = Array.from({ length: 8 }, (_, index) => noisePng(index + 1));

let link = { latencyMs: 0, bytesPerSec: Infinity };
let linkFreeAt = 0;
const stats = { page: 0, api: 0, images: 0, imageBytes: 0 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function send(res, status, type, buffer) {
  if (link.latencyMs > 0) await sleep(link.latencyMs);
  res.writeHead(status, { 'content-type': type, 'content-length': buffer.length, 'cache-control': 'no-store' });
  for (let offset = 0; offset < buffer.length; offset += CHUNK) {
    const part = buffer.subarray(offset, offset + CHUNK);
    if (link.bytesPerSec !== Infinity) {
      const now = Date.now();
      linkFreeAt = Math.max(now, linkFreeAt) + (part.length / link.bytesPerSec) * 1000;
      const wait = linkFreeAt - now;
      if (wait > 0) await sleep(wait);
    }
    if (!res.write(part)) await new Promise((resolve) => res.once('drain', resolve));
  }
  res.end();
}

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Order desk</title></head><body><main>
<h1>Order desk</h1>
<label for="q">Search</label> <input id="q"> <button id="go" type="button">Search</button>
<p id="out" role="status"></p>
<div id="gallery">${Array.from({ length: IMAGES }, (_, i) => `<img src="/img/${i}.png" width="80" height="60" alt="">`).join('')}</div>
<script>document.getElementById('go').onclick = async () => { const r = await fetch('/api/search?q=' + encodeURIComponent(document.getElementById('q').value)); document.getElementById('out').textContent = (await r.json()).answer; };</script>
</main></body></html>`;

http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    try {
      if (url.pathname === '/__mode') {
        const mbps = Number(url.searchParams.get('mbps') ?? '0');
        link = { latencyMs: Number(url.searchParams.get('latency') ?? '0'), bytesPerSec: mbps > 0 ? (mbps * 1_000_000) / 8 : Infinity };
        linkFreeAt = 0;
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ latencyMs: link.latencyMs, bytesPerSec: link.bytesPerSec === Infinity ? null : link.bytesPerSec }));
      } else if (url.pathname === '/__stats') {
        const out = JSON.stringify(stats);
        if (url.searchParams.get('reset')) Object.assign(stats, { page: 0, api: 0, images: 0, imageBytes: 0 });
        res.writeHead(200, { 'content-type': 'application/json' }).end(out);
      } else if (url.pathname.startsWith('/img/')) {
        const picture = pictures[Number.parseInt(url.pathname.slice(5), 10) % pictures.length];
        stats.images += 1;
        stats.imageBytes += picture.length;
        await send(res, 200, 'image/png', picture);
      } else if (url.pathname === '/api/search') {
        stats.api += 1;
        await send(res, 200, 'application/json', Buffer.from(JSON.stringify({ answer: `found ${url.searchParams.get('q') ?? ''}` })));
      } else if (url.pathname === '/') {
        stats.page += 1;
        await send(res, 200, 'text/html; charset=utf-8', Buffer.from(html));
      } else {
        res.writeHead(404).end();
      }
    } catch {
      res.destroy();
    }
  })
  .listen(PORT, '127.0.0.1', () => console.log(`heavy-site on http://localhost:${PORT} (${IMAGES} images of ~${Math.round(pictures[0].length / 1024)} KB)`));
