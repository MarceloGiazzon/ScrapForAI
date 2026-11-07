import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// The "evidence not found for a run that had just finished" flake (full smoke suite, a different file each time, never alone, no log
// line): `nanoid(12)` draws from A-Za-z0-9_- , so about one job id in 64 ENDS in a hyphen, and `safeFileName` strips hyphens from both
// ends of a name. The folder was then `job_abc` while the run said `job_abc-`, and every later lookup by id missed it.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-artifact-store-test-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
// .env may pin ARTIFACT_DIR; dotenv never overrides an existing variable.
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com';

const { nanoid } = await import('nanoid');
const { createArtifactStore, jobDirName, JOB_ID_PATTERN } = await import('../src/artifacts/artifactStore.js');
const { findJobDir, resolveJobFile } = await import('../src/evidence/locate.js');

after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('the folder of a job is named exactly like the job id, also when the id ends in a hyphen or an underscore', async () => {
  for (const jobId of ['job_abcdefghijk-', 'job_abcdefghijk_', 'job_abcdefghij--', 'job_-abcdefghijk', 'job_abc-def_ghi-']) {
    const store = await createArtifactStore(jobId);
    assert.equal(path.basename(store.rootDir), jobId);
    assert.equal(store.relativeRoot, `artifacts/${jobId}`);
    fs.writeFileSync(store.resultPath().absolutePath, JSON.stringify({ jobId }));

    // What every later reader does: look the run up by the id the run reported.
    assert.equal(findJobDir(jobId)?.dir, store.rootDir, `findJobDir(${jobId})`);
    assert.equal(resolveJobFile(jobId, 'result.json'), store.resultPath().absolutePath);
  }
});

test('every id the runner can generate keeps its name (a hyphen at the end was dropped about once in 64 runs)', () => {
  let endingInHyphen = 0;
  for (let i = 0; i < 5000; i += 1) {
    const jobId = `job_${nanoid(12)}`;
    assert.match(jobId, JOB_ID_PATTERN);
    if (jobId.endsWith('-')) endingInHyphen += 1;
    assert.equal(jobDirName(jobId), jobId);
  }
  // Not an assertion about nanoid, only proof that this run did exercise the case that used to lose evidence.
  assert.ok(endingInHyphen > 0, 'no generated id ended in a hyphen in 5000 draws: the sample does not cover the case');
});

test('a name that is not a job id is still made safe for a file system', () => {
  assert.equal(jobDirName('../../etc/passwd'), 'etc-passwd');
  assert.equal(jobDirName('  weird name!  '), 'weird-name');
  assert.equal(jobDirName('---'), 'job');
});
