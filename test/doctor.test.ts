import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { EXAMPLE_API_KEY, EXAMPLE_TARGET_ORIGINS } from '../src/config/exampleConfig.js';
import {
  checkConfigInvalid,
  checkExampleValues,
  checkExposure,
  checkNode,
  checkPort,
  checkTarget,
  exitCodeFor,
  nodeAtLeast,
  parseMinNode,
  renderReport,
  type CheckResult,
} from '../src/doctor/report.js';

test('parseMinNode reads ">=" ranges and nothing else', () => {
  assert.equal(parseMinNode('>=22.13.0'), '22.13.0');
  assert.equal(parseMinNode('>=22'), '22.0.0');
  assert.equal(parseMinNode(' >= v22.13 '), '22.13.0');
  for (const unsupported of ['^22.13.0', '^20.19.0 || ^22.13.0 || >=24', '', undefined, 'latest']) {
    assert.equal(parseMinNode(unsupported), undefined, String(unsupported));
  }
});

test('nodeAtLeast compares major, minor and patch numerically (22.9 is older than 22.13)', () => {
  assert.ok(nodeAtLeast('v22.13.0', '22.13.0'));
  assert.ok(nodeAtLeast('24.22.1', '22.13.0'));
  assert.ok(nodeAtLeast('22.13.1', '22.13.0'));
  assert.ok(!nodeAtLeast('22.9.0', '22.13.0'), 'a string comparison would say 22.9 > 22.13');
  assert.ok(!nodeAtLeast('v18.19.1', '22.0.0'), 'the Node the review found on the Ubuntu machine');
});

test('package.json demands what eslint (a dev dependency) demands, so npm ci on a too-old Node is caught by the doctor and not by a warning', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { engines: { node: string } };
  const minimum = parseMinNode(pkg.engines.node);
  assert.ok(minimum, `engines.node "${pkg.engines.node}" must be a ">=" range the doctor understands`);
  assert.ok(nodeAtLeast(minimum, '22.13.0'), `eslint needs ^22.13.0 and engines.node says ${pkg.engines.node}`);
});

test('an old Node is a failure with cause, impact and the next step', () => {
  const result = checkNode('v18.19.1', '>=22.13.0');
  assert.equal(result.level, 'fail');
  assert.match(result.title, /18\.19\.1/);
  assert.match(result.impact ?? '', /EBADENGINE/);
  assert.match(result.next ?? '', /Node\.js 22/);
  assert.equal(checkNode('v24.22.1', '>=22.13.0').level, 'ok');
  assert.equal(checkNode('v24.22.1', undefined).level, 'ok');
});

test('an invalid configuration lists the variables, not their values', () => {
  const result = checkConfigInvalid([
    { path: ['SCRAPFORAI_API_KEY'], message: 'SCRAPFORAI_API_KEY must be at least 16 characters' },
    { path: ['ALLOWED_TARGET_ORIGINS'], message: 'ALLOWED_TARGET_ORIGINS must contain at least one origin' },
  ]);
  assert.equal(result.level, 'fail');
  assert.match(result.detail ?? '', /SCRAPFORAI_API_KEY: SCRAPFORAI_API_KEY must be at least 16 characters/);
  assert.match(result.detail ?? '', /ALLOWED_TARGET_ORIGINS/);
  assert.match(result.next ?? '', /\.env\.example/);
});

test('the example values fail with the fix, and real ones pass; the key itself is never in the report', () => {
  const bad = checkExampleValues({ SCRAPFORAI_API_KEY: `${EXAMPLE_API_KEY}-xyz`, ALLOWED_TARGET_ORIGINS: [...EXAMPLE_TARGET_ORIGINS] });
  assert.equal(bad.level, 'fail');
  assert.match(bad.next ?? '', /randomBytes/);
  assert.ok(!JSON.stringify(bad).includes('-xyz'));
  assert.equal(checkExampleValues({ SCRAPFORAI_API_KEY: 'a-real-generated-key-0123456789', ALLOWED_TARGET_ORIGINS: ['http://localhost:5173'] }).level, 'ok');
});

test('exposure: a non-loopback HOST and ALLOW_EVALUATE are warnings (a person may mean them), loopback is fine', () => {
  const exposed = checkExposure({ HOST: '0.0.0.0', ALLOW_EVALUATE: true, TRUST_PROXY: 0 });
  assert.deepEqual(exposed.map((result) => [result.id, result.level]), [['host', 'warn'], ['evaluate', 'warn']]);
  assert.match(exposed[0]!.next ?? '', /HOST=127\.0\.0\.1/);
  const local = checkExposure({ HOST: '127.0.0.1', ALLOW_EVALUATE: false, TRUST_PROXY: 0 });
  assert.deepEqual(local.map((result) => [result.id, result.level]), [['host', 'ok']]);
  for (const host of ['localhost', '::1', '[::1]', ' LOCALHOST ']) {
    assert.equal(checkExposure({ HOST: host, ALLOW_EVALUATE: false, TRUST_PROXY: 0 })[0]!.level, 'ok', host);
  }
});

test('port: free and "ScrapForAI is already here" are fine, anything else is a failure with the right command per platform', () => {
  assert.equal(checkPort(3000, 'free', 'linux').level, 'ok');
  assert.equal(checkPort(3000, 'scrapforai', 'linux').level, 'ok');
  const win = checkPort(3000, 'other', 'win32');
  assert.equal(win.level, 'fail');
  assert.match(win.next ?? '', /netstat -ano \| findstr :3000/);
  assert.match(checkPort(3000, 'other', 'linux').next ?? '', /lsof -i :3000/);
});

test('a target that does not answer is a warning, one that does is fine (any HTTP status is an answer)', () => {
  assert.equal(checkTarget('http://localhost:5173', { status: 404 }).level, 'ok');
  const down = checkTarget('http://localhost:5173', { error: 'nothing is listening there (connection refused)' });
  assert.equal(down.level, 'warn');
  assert.match(down.impact ?? '', /TargetUnreachable/);
});

test('exit code: only a failure makes it 1; warnings do not', () => {
  const ok: CheckResult = { id: 'a', level: 'ok', title: 'a' };
  const warn: CheckResult = { id: 'b', level: 'warn', title: 'b' };
  const fail: CheckResult = { id: 'c', level: 'fail', title: 'c' };
  assert.equal(exitCodeFor([ok, warn]), 0);
  assert.equal(exitCodeFor([ok, warn, fail]), 1);
  assert.equal(exitCodeFor([]), 0);
});

test('the report shows impact and next only for what is not fine, and sums up', () => {
  const text = renderReport([
    { id: 'a', level: 'ok', title: 'Node.js 24.22.1', impact: 'must not appear', next: 'must not appear' },
    { id: 'b', level: 'warn', title: 'HOST=0.0.0.0', impact: 'reachable', next: 'set HOST=127.0.0.1' },
    { id: 'c', level: 'fail', title: 'Port 3000 is taken', detail: 'by node.exe', impact: 'EADDRINUSE', next: 'stop it' },
  ]);
  assert.match(text, /✔ Node\.js 24\.22\.1/);
  assert.match(text, /⚠ HOST=0\.0\.0\.0\n    Impact: reachable\n    Next:   set HOST=127\.0\.0\.1/);
  assert.match(text, /✖ Port 3000 is taken\n    by node\.exe\n    Impact: EADDRINUSE\n    Next:   stop it/);
  assert.ok(!text.includes('must not appear'));
  assert.match(text, /1 problem to fix, 1 warning\./);
  assert.match(renderReport([{ id: 'a', level: 'ok', title: 'x' }]), /Everything checks out/);
  assert.match(renderReport([{ id: 'a', level: 'warn', title: 'x' }]), /Ready to start, with 1 warning/);
});
