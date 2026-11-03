import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const API_KEY = 'test-api-key-1234567890';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-signing-test-'));
process.env.SCRAPFORAI_API_KEY = API_KEY;
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts'); // .env may pin it
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com';
process.env.ALLOWED_RESOURCE_ORIGINS = 'https://dev.example.com';
process.env.PINNED_EVIDENCE_MAX_MB = '100';

const express = (await import('express')).default;
const { env } = await import('../src/config/env.js');
const { apiAuth } = await import('../src/security/apiAuth.js');
const { runsRouter } = await import('../src/routes/runs.routes.js');
const { evidenceRouter } = await import('../src/routes/evidence.routes.js');
const { buildManifest, writeManifest, readManifest } = await import('../src/evidence/manifest.js');
const { pinJob } = await import('../src/evidence/pin.js');
const { pinnedEvidenceDir } = await import('../src/config/paths.js');
const { generateSigningKeyPair, signManifest, checkSignature, keyFingerprint } = await import('../src/evidence/signature.js');
const { verifyChain } = await import('../src/evidence/chain.js');
const { verifyEvidenceDir, PUBLIC_KEY_FILE } = await import('../src/evidence/verify.js');
const { exportEvidence } = await import('../src/evidence/export.js');
const { createZip, readZip } = await import('../src/evidence/zip.js');
const { loadPublicKey } = await import('../src/evidence/signingKey.js');

let server: http.Server;
let baseUrl: string;
const bearer = { authorization: `Bearer ${API_KEY}` };

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(apiAuth);
  app.use('/v1/runs', runsRouter);
  app.use('/v1/evidence', evidenceRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function makeJob(jobId: string): Promise<string> {
  const dir = path.join(env.ARTIFACT_DIR, jobId);
  fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ jobId, status: 'failed', scenarioName: 'cart', targetUrl: 'https://dev.example.com/', buildId: 'rev1', routine: { id: 'r', version: 2, sha256: 'a'.repeat(64) } }));
  fs.writeFileSync(path.join(dir, 'screenshots', 'failure.png'), Buffer.from(`png-bytes-${jobId}`));
  await writeManifest(dir, await buildManifest(dir, jobId, 'ephemeral'));
  return dir;
}

const pin = (jobId: string) => pinJob(jobId, { reason: 'proof', ref: 'test:1' });
const pinned = (jobId: string) => path.join(pinnedEvidenceDir(), jobId);

test('Ed25519: a signature verifies; any change, another key, or no signature does not', () => {
  const a = generateSigningKeyPair();
  const b = generateSigningKeyPair();
  assert.equal(a.keyId, keyFingerprint(a.publicKeyPem));
  assert.match(a.keyId, /^[0-9a-f]{64}$/);

  const manifest = { version: 1, jobId: 'job_x', files: [{ path: 'a', sha256: '1'.repeat(64) }] };
  const signed = signManifest(manifest, a.privateKeyPem, a.publicKeyPem);
  assert.deepEqual(checkSignature(signed, a.publicKeyPem), { status: 'valid', keyId: a.keyId });

  assert.equal(checkSignature({ ...signed, jobId: 'job_y' }, a.publicKeyPem).status, 'invalid');
  assert.equal(checkSignature({ ...signed, files: [] }, a.publicKeyPem).status, 'invalid');
  assert.deepEqual(checkSignature(signed, b.publicKeyPem), { status: 'invalid', reason: 'key-mismatch', keyId: a.keyId });
  assert.equal(checkSignature(manifest, a.publicKeyPem).status, 'unsigned');
  assert.equal(checkSignature({ ...signed, signature: { ...signed.signature, value: 'AAAA' } }, a.publicKeyPem).status, 'invalid');

  // Key order does not matter: the signed bytes are canonical.
  assert.equal(checkSignature({ files: signed.files, signature: signed.signature, jobId: 'job_x', version: 1 }, a.publicKeyPem).status, 'valid');
});

test('pinning signs the manifest and chains it to the previous one', async () => {
  for (const id of ['job_c1', 'job_c2', 'job_c3']) {
    await makeJob(id);
    await pin(id);
  }

  const key = await loadPublicKey();
  const manifests = await Promise.all(['job_c1', 'job_c2', 'job_c3'].map(async (id) => (await readManifest(pinned(id)))!));
  assert.deepEqual(manifests.map((m) => m.manifest.chain?.sequence), [1, 2, 3]);
  assert.equal(manifests[0]!.manifest.chain?.previousManifestSha256, null);
  assert.equal(manifests[1]!.manifest.chain?.previousManifestSha256, manifests[0]!.sha256);
  assert.equal(manifests[2]!.manifest.chain?.previousManifestSha256, manifests[1]!.sha256);
  assert.ok(manifests.every((m) => checkSignature(m.manifest, key.publicKeyPem).status === 'valid'));
  assert.deepEqual(manifests[0]!.manifest.context, { scenarioName: 'cart', targetUrl: 'https://dev.example.com/', buildId: 'rev1', routine: { id: 'r', version: 2, sha256: 'a'.repeat(64) }, status: 'failed' });

  const chain = await verifyChain({ publicKeyPem: key.publicKeyPem, deep: true });
  assert.deepEqual([chain.ok, chain.signed, chain.highestSequence, chain.problems], [true, 3, 3, []]);

  // The signing key lives in the data dir, and the private half is never in an export or an API response.
  assert.ok(fs.existsSync(path.join(dataDir, 'signing', 'ed25519.key')));
  const publicInfo = await (await fetch(`${baseUrl}/v1/evidence/public-key`, { headers: bearer })).text();
  assert.ok(!publicInfo.includes('PRIVATE KEY'));
  assert.equal(JSON.parse(publicInfo).keyId, key.keyId);
});

test('changing 1 byte of a pinned screenshot is detected, naming the file (folder check and deep chain)', async () => {
  const dir = pinned('job_c2');
  const png = path.join(dir, 'screenshots', 'failure.png');
  const original = fs.readFileSync(png);
  const bytes = Buffer.from(original);
  bytes[0] = (bytes[0] ?? 0) ^ 0x01;
  fs.writeFileSync(png, bytes);

  try {
    const { publicKeyPem } = await loadPublicKey();
    const result = await verifyEvidenceDir(dir, { publicKeyPem });
    assert.equal(result.ok, false);
    assert.deepEqual(result.files.problems, [{ path: 'screenshots/failure.png', problem: 'modified' }]);
    assert.equal(result.signature.status, 'valid', 'the manifest itself is intact; the file is what changed');
    assert.deepEqual(result.reasons, ['screenshots/failure.png: modified']);

    const shallow = await verifyChain({ publicKeyPem });
    assert.equal(shallow.ok, true, 'a shallow chain check only reads manifests');
    const deep = await verifyChain({ publicKeyPem, deep: true });
    assert.deepEqual(deep.problems.map((p) => [p.kind, p.jobId]), [['files-modified', 'job_c2']]);
  } finally {
    fs.writeFileSync(png, original);
  }
});

test('editing a manifest breaks its signature and the next link; the rest of the chain still verifies', async () => {
  const file = path.join(pinned('job_c2'), 'manifest.json');
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, original.replace('"reason": "proof"', '"reason": "forged"'));

  try {
    const { publicKeyPem } = await loadPublicKey();
    const chain = await verifyChain({ publicKeyPem });
    assert.deepEqual(chain.problems.map((p) => [p.kind, p.jobId]), [['invalid-signature', 'job_c2'], ['broken-link', 'job_c3']]);

    // Re-signing with a different key does not help either.
    const other = generateSigningKeyPair();
    const manifest = JSON.parse(original);
    delete manifest.signature;
    fs.writeFileSync(file, JSON.stringify(signManifest(manifest, other.privateKeyPem, other.publicKeyPem), null, 2));
    assert.ok((await verifyChain({ publicKeyPem })).problems.some((p) => p.kind === 'key-mismatch' && p.jobId === 'job_c2'));
  } finally {
    fs.writeFileSync(file, original);
  }
  assert.equal((await verifyChain({ publicKeyPem: (await loadPublicKey()).publicKeyPem })).ok, true);
});

test('removing a manifest from the middle of the chain is detected (gap); removing the latest is detected too', async () => {
  const { publicKeyPem } = await loadPublicKey();

  // Middle: take job_c2 away.
  fs.renameSync(pinned('job_c2'), path.join(dataDir, 'moved-c2'));
  try {
    const chain = await verifyChain({ publicKeyPem });
    assert.equal(chain.ok, false);
    assert.deepEqual(chain.problems.map((p) => [p.kind, p.jobId, p.sequence]), [['gap', 'job_c3', 3]]);
    assert.match(chain.problems[0]!.detail, /sequence 2 is missing between job_c1 and job_c3/);
  } finally {
    fs.renameSync(path.join(dataDir, 'moved-c2'), pinned('job_c2'));
  }

  // Latest: nothing after it points back, but the high-water mark remembers sequence 3.
  fs.renameSync(pinned('job_c3'), path.join(dataDir, 'moved-c3'));
  try {
    const chain = await verifyChain({ publicKeyPem });
    assert.deepEqual(chain.problems.map((p) => p.kind), ['truncated']);
    assert.match(chain.problems[0]!.detail, /sequence 3 was recorded but the chain ends at 2/);
  } finally {
    fs.renameSync(path.join(dataDir, 'moved-c3'), pinned('job_c3'));
  }

  assert.equal((await verifyChain({ publicKeyPem })).ok, true);
});

test('evidence pinned before signing existed is listed as unsigned, not trusted, and does not break the chain', async () => {
  const legacy = pinned('job_legacy');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'result.json'), '{}');
  const manifest = await buildManifest(legacy, 'job_legacy', 'pinned', { pinnedAt: 'then', reason: 'old', keepTrace: false, traceDiscarded: false, integrityBaseline: 'pin' });
  await writeManifest(legacy, manifest);

  const { publicKeyPem } = await loadPublicKey();
  const chain = await verifyChain({ publicKeyPem });
  assert.deepEqual([chain.ok, chain.signed, chain.unsigned], [true, 3, ['job_legacy']]);
  assert.deepEqual((await verifyEvidenceDir(legacy, { publicKeyPem })).reasons, ['the manifest is not signed']);

  await assert.rejects(() => exportEvidence('job_legacy'), (error: Error & { status?: number }) => error.name === 'NotSigned' && error.status === 409);
  fs.rmSync(legacy, { recursive: true, force: true });
});

test('export: a zip with files, signed manifest, public key and README that verifies on another machine', async () => {
  const { zip, fileName, keyId } = await exportEvidence('job_c1');
  assert.equal(fileName, 'job_c1.evidence.zip');

  const entries = readZip(zip);
  assert.deepEqual(entries.map((e) => e.name).sort(), ['README.txt', 'manifest.json', PUBLIC_KEY_FILE, 'result.json', 'screenshots/failure.png']);
  assert.ok(!entries.some((e) => e.data.toString('utf8').includes('PRIVATE KEY')));
  assert.match(entries.find((e) => e.name === 'README.txt')!.data.toString('utf8'), new RegExp(keyId));

  // "Another machine": extract to a fresh folder and verify with nothing but the folder.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-verify-elsewhere-'));
  try {
    for (const entry of entries) {
      fs.mkdirSync(path.dirname(path.join(other, entry.name)), { recursive: true });
      fs.writeFileSync(path.join(other, entry.name), entry.data);
    }

    const ok = await verifyEvidenceDir(other);
    assert.deepEqual([ok.ok, ok.keySource, ok.signature.status, ok.chain?.sequence], [true, 'bundle', 'valid', 1]);
    assert.equal((await verifyEvidenceDir(other, { expectedKeyId: keyId })).keyTrusted, true);

    const wrongKey = await verifyEvidenceDir(other, { expectedKeyId: 'f'.repeat(64) });
    assert.equal(wrongKey.ok, false);
    assert.ok(wrongKey.reasons.includes('the signing key is not the expected one'));

    // A forger who swaps both the files and the key inside the bundle gets a self-consistent bundle that
    // fails the one check that matters: the expected key id.
    const forger = generateSigningKeyPair();
    const manifest = JSON.parse(fs.readFileSync(path.join(other, 'manifest.json'), 'utf8'));
    delete manifest.signature;
    fs.writeFileSync(path.join(other, 'manifest.json'), JSON.stringify(signManifest(manifest, forger.privateKeyPem, forger.publicKeyPem)));
    fs.writeFileSync(path.join(other, PUBLIC_KEY_FILE), forger.publicKeyPem);
    assert.equal((await verifyEvidenceDir(other)).ok, true, 'self-consistent...');
    assert.equal((await verifyEvidenceDir(other, { expectedKeyId: keyId })).ok, false, '...but not signed by the key you were told to expect');

    // Tampering with a file is caught with no key at all needed for that part.
    fs.writeFileSync(path.join(other, 'result.json'), '{"status":"passed"}');
    const tampered = await verifyEvidenceDir(other, { publicKeyPem: (await loadPublicKey()).publicKeyPem });
    assert.equal(tampered.ok, false);
    assert.ok(tampered.reasons.some((r) => r.startsWith('result.json')));
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
  }

  const noKey = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-verify-nokey-'));
  try {
    for (const entry of entries.filter((e) => e.name !== PUBLIC_KEY_FILE)) {
      fs.mkdirSync(path.dirname(path.join(noKey, entry.name)), { recursive: true });
      fs.writeFileSync(path.join(noKey, entry.name), entry.data);
    }
    const result = await verifyEvidenceDir(noKey);
    assert.equal(result.ok, false);
    assert.match(result.reasons.join(), /no public key/);
  } finally {
    fs.rmSync(noKey, { recursive: true, force: true });
  }
});

test('GET /v1/runs/:id/export streams the zip; not pinned is 409, unknown is 404; /manifest reports the signature', async () => {
  const response = await fetch(`${baseUrl}/v1/runs/job_c1/export`, { headers: bearer });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.match(response.headers.get('content-disposition') ?? '', /job_c1\.evidence\.zip/);
  assert.equal(readZip(Buffer.from(await response.arrayBuffer())).length, 5);

  await makeJob('job_unpinned');
  const unpinned = await fetch(`${baseUrl}/v1/runs/job_unpinned/export`, { headers: bearer });
  assert.equal(unpinned.status, 409);
  assert.equal(((await unpinned.json()) as any).error.type, 'NotPinned');
  assert.equal((await fetch(`${baseUrl}/v1/runs/job_nope/export`, { headers: bearer })).status, 404);
  assert.equal((await fetch(`${baseUrl}/v1/runs/job_c1/export`)).status, 401);

  const manifest = (await (await fetch(`${baseUrl}/v1/runs/job_c1/manifest`, { headers: bearer })).json()) as any;
  assert.equal(manifest.signature.status, 'valid');
  const plain = (await (await fetch(`${baseUrl}/v1/runs/job_unpinned/manifest`, { headers: bearer })).json()) as any;
  assert.equal(plain.signature.status, 'unsigned');

  const chain = (await (await fetch(`${baseUrl}/v1/evidence/chain?deep=1`, { headers: bearer })).json()) as any;
  assert.deepEqual([chain.ok, chain.signed, chain.deep], [true, 3, true]);
});

test('export refuses evidence that was damaged after pinning', async () => {
  const png = path.join(pinned('job_c3'), 'screenshots', 'failure.png');
  const original = fs.readFileSync(png);
  fs.writeFileSync(png, Buffer.from('damaged'));
  try {
    await assert.rejects(() => exportEvidence('job_c3'), (error: Error & { status?: number }) => error.name === 'EvidenceIntegrityError' && error.status === 409);
  } finally {
    fs.writeFileSync(png, original);
  }
});

test('zip: round-trips binary data and refuses entries that could escape the folder', () => {
  const binary = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
  const entries = readZip(createZip([{ name: 'a/b.bin', data: binary }, { name: 'empty.txt', data: Buffer.alloc(0) }, { name: 'ñ.txt', data: Buffer.from('é') }]));
  assert.deepEqual(entries.map((e) => e.name), ['a/b.bin', 'empty.txt', 'ñ.txt']);
  assert.ok(entries[0]!.data.equals(binary));
  assert.equal(entries[2]!.data.toString(), 'é');

  for (const name of ['../evil.txt', '/abs.txt', 'a/../../x', 'a\\b.txt']) {
    assert.throws(() => readZip(createZip([{ name, data: Buffer.from('x') }])), /Unsafe path/, name);
  }
  assert.throws(() => readZip(Buffer.from('not a zip at all, definitely not')), /Not a zip/);
});
