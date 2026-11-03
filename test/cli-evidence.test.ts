import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

process.env.SCRAPFORAI_API_KEY ??= 'test-api-key-1234567890';
process.env.ALLOWED_TARGET_ORIGINS ??= 'https://dev.example.com';

const { runCli } = await import('../src/cli/runCli.js');
const { cliOutputSchema } = await import('../src/schemas/cliOutput.schema.js');
const { buildManifest, writeManifest } = await import('../src/evidence/manifest.js');
const { generateSigningKeyPair, signManifest } = await import('../src/evidence/signature.js');

const KEY = 'cli-test-key-1234567890';
const KEY_ID = 'c'.repeat(64);

let server: http.Server;
let baseUrl: string;
let seen: Array<{ url: string; auth: string | undefined }> = [];
let handler: (url: string, respond: (status: number, body: unknown, headers?: Record<string, string>, raw?: Buffer) => void) => void = () => undefined;

before(async () => {
  server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', auth: req.headers.authorization });
    handler(req.url ?? '', (status, body, headers = {}, raw) => {
      res.statusCode = status;
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
      if (raw) {
        res.end(raw);
      } else {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function cli(args: string[], extra: Partial<Parameters<typeof runCli>[2]> = {}, url = baseUrl) {
  const out: string[] = [];
  const err: string[] = [];
  seen = [];
  const code = await runCli(args, { baseUrl: url, apiKey: KEY, requestTimeoutMs: 5000 }, { out: (t) => void out.push(t), err: (t) => void err.push(t), ...extra });
  return { code, stdout: out.join(''), stderr: err.join('') };
}

function validJson(stdout: string): any {
  assert.equal(stdout.trim().split('\n').length, 1);
  const parsed = JSON.parse(stdout);
  assert.ok(cliOutputSchema.safeParse(parsed).success, JSON.stringify(cliOutputSchema.safeParse(parsed)));
  return parsed;
}

test('evidence chain: ok is 0, a broken chain is 1', async () => {
  const chain = (over: Record<string, unknown>) => ({ ok: true, keyId: KEY_ID, deep: false, entries: 3, signed: 3, unsigned: [], highestSequence: 3, problems: [], ...over });
  handler = (_url, respond) => respond(200, chain({}));
  const ok = await cli(['evidence', 'chain', '--deep', '--json']);
  assert.equal(ok.code, 0);
  assert.equal(seen[0]!.url, '/v1/evidence/chain?deep=1');
  validJson(ok.stdout);

  handler = (_url, respond) => respond(200, chain({ ok: false, problems: [{ kind: 'gap', detail: 'sequence 2 is missing between job_a and job_c' }] }));
  const broken = await cli(['evidence', 'chain']);
  assert.equal(broken.code, 1);
  assert.match(broken.stdout, /CHAIN BROKEN[\s\S]*gap: sequence 2 is missing/);
});

test('evidence export writes the zip and prints the key id to verify against', async () => {
  const zip = Buffer.from('PK-fake-zip-bytes');
  const written: Array<{ file: string; data: Buffer }> = [];
  const writeFile = async (file: string, data: Buffer) => void written.push({ file, data });

  handler = (url, respond) =>
    url === '/v1/runs/job_abc/export'
      ? respond(200, undefined, { 'content-type': 'application/zip', 'x-scrapforai-key-id': KEY_ID }, zip)
      : respond(409, { error: { type: 'NotPinned', message: 'pin it first' } });

  const ok = await cli(['evidence', 'export', 'job_abc', '--out', 'proof.zip', '--json'], { writeFile });
  assert.equal(ok.code, 0);
  assert.deepEqual(written, [{ file: 'proof.zip', data: zip }]);
  assert.deepEqual([validJson(ok.stdout).result.keyId, validJson(ok.stdout).result.bytes], [KEY_ID, zip.length]);
  assert.equal(seen[0]!.auth, `Bearer ${KEY}`);

  const human = await cli(['evidence', 'export', 'job_abc', '--out', 'proof.zip'], { writeFile });
  assert.match(human.stdout, new RegExp(`--expected-key-id ${KEY_ID}`));

  const refused = await cli(['evidence', 'export', 'job_other', '--out', 'x.zip', '--json'], { writeFile });
  assert.equal(refused.code, 2);
  assert.equal(validJson(refused.stdout).error.type, 'NotPinned');
  assert.equal(written.length, 2, 'a refused export writes nothing');
});

test('evidence verify <jobId> uses the server; unsigned or tampered is exit 1', async () => {
  const body = (over: Record<string, unknown>) => ({
    location: 'pinned',
    manifestSha256: 'd'.repeat(64),
    manifest: { jobId: 'job_abc', chain: { sequence: 2, previousManifestSha256: 'e'.repeat(64) } },
    verification: { ok: true, checked: 3, problems: [] },
    signature: { status: 'valid', keyId: KEY_ID },
    ...over,
  });

  handler = (_url, respond) => respond(200, body({}));
  const ok = await cli(['evidence', 'verify', 'job_abc', '--expected-key-id', KEY_ID, '--json']);
  assert.equal(ok.code, 0);
  assert.deepEqual([validJson(ok.stdout).result.source, validJson(ok.stdout).result.keyTrusted], ['server', true]);

  const wrongKey = await cli(['evidence', 'verify', 'job_abc', '--expected-key-id', 'f'.repeat(64)]);
  assert.equal(wrongKey.code, 1);
  assert.match(wrongKey.stdout, /not the expected one/);

  handler = (_url, respond) => respond(200, body({ location: 'artifacts', signature: { status: 'unsigned' } }));
  const unsigned = await cli(['evidence', 'verify', 'job_abc']);
  assert.equal(unsigned.code, 1);
  assert.match(unsigned.stdout, /only pinned evidence is signed/);

  handler = (_url, respond) => respond(200, body({ verification: { ok: false, checked: 3, problems: [{ path: 'screenshots/failure.png', problem: 'modified' }] } }));
  const tampered = await cli(['evidence', 'verify', 'job_abc']);
  assert.equal(tampered.code, 1);
  assert.match(tampered.stdout, /NOT VERIFIED[\s\S]*screenshots\/failure\.png: modified/);

  handler = (_url, respond) => respond(404, { error: { type: 'NotFound', message: 'No manifest for this run' } });
  assert.equal((await cli(['evidence', 'verify', 'job_nope'])).code, 2);
  assert.equal((await cli(['evidence', 'verify', 'job_abc', '--expected-key-id', 'short'])).code, 2);
  assert.equal((await cli(['evidence', 'export', 'job_abc'])).code, 2, '--out is required');
});

test('evidence verify <folder> works with no API at all', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-cli-evidence-'));
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-cli-notevidence-'));
  try {
    fs.writeFileSync(path.join(dir, 'result.json'), '{"status":"failed"}');
    const pair = generateSigningKeyPair();
    const base = await buildManifest(dir, 'job_folder1', 'pinned');
    await writeManifest(dir, signManifest({ ...base, chain: { sequence: 1, previousManifestSha256: null } }, pair.privateKeyPem, pair.publicKeyPem) as never);
    fs.writeFileSync(path.join(dir, 'public-key.pem'), pair.publicKeyPem);

    const dead = 'http://127.0.0.1:9';
    const isDirectory = async (p: string) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() === true;

    const ok = await cli(['evidence', 'verify', dir, '--expected-key-id', pair.keyId, '--json'], { isDirectory }, dead);
    assert.equal(ok.code, 0);
    assert.deepEqual([validJson(ok.stdout).result.source, validJson(ok.stdout).result.keySource], ['folder', 'bundle']);

    const human = await cli(['evidence', 'verify', dir], { isDirectory }, dead);
    assert.match(human.stdout, /VERIFIED[\s\S]*the key came from the folder itself/);

    fs.writeFileSync(path.join(dir, 'result.json'), '{"status":"passed"}');
    const tampered = await cli(['evidence', 'verify', dir, '--json'], { isDirectory }, dead);
    assert.equal(tampered.code, 1);
    assert.deepEqual(validJson(tampered.stdout).result.files.problems, [{ path: 'result.json', problem: 'modified' }]);

    const notEvidence = await cli(['evidence', 'verify', empty, '--json'], { isDirectory }, dead);
    assert.equal(notEvidence.code, 2);
    assert.equal(validJson(notEvidence.stdout).error.type, 'NotEvidence');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('report downloads the html/pdf for a run or a suite and writes it', async () => {
  const written: Array<{ file: string; data: Buffer }> = [];
  const writeFile = async (file: string, data: Buffer) => void written.push({ file, data });
  handler = (url, respond) =>
    url.startsWith('/v1/runs/job_abc/report') || url.startsWith('/v1/suites/suite_abc/report')
      ? respond(200, undefined, { 'content-type': 'application/pdf' }, Buffer.from('%PDF-1.7 fake'))
      : respond(409, { error: { type: 'SuiteRunning', message: 'wait' } });

  const run = await cli(['report', 'job_abc', '--out', 'r.pdf', '--format', 'pdf', '--lang', 'es', '--json'], { writeFile });
  assert.equal(run.code, 0);
  assert.equal(seen[0]!.url, '/v1/runs/job_abc/report?format=pdf&lang=es');
  assert.deepEqual(validJson(run.stdout).result, { id: 'job_abc', format: 'pdf', lang: 'es', path: 'r.pdf', bytes: 13 });

  await cli(['report', 'suite_abc', '--out', 's.html'], { writeFile });
  assert.equal(seen[0]!.url, '/v1/suites/suite_abc/report?format=html&lang=en');
  assert.equal(written.length, 2);

  const running = await cli(['report', 'suite_other', '--out', 'x.html', '--json'], { writeFile });
  assert.equal(running.code, 2);
  assert.equal(validJson(running.stdout).error.type, 'SuiteRunning');
  assert.equal(written.length, 2, 'a refused report writes nothing');

  seen = [];
  for (const args of [['report', 'job_abc'], ['report', 'nope_1', '--out', 'x'], ['report', 'job_abc', '--out', 'x', '--format', 'docx'], ['report', 'job_abc', '--out', 'x', '--lang', 'fr']]) {
    assert.equal((await cli(args, { writeFile })).code, 2, args.join(' '));
  }
  assert.equal(seen.length, 0);
});
