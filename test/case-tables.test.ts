import assert from 'node:assert/strict';
import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

// T5.5, tables of cases: the CSV reader, the versioned library, the resolution (a column becomes `cases`, an expected cell becomes the
// literal of the run's row), the secret lint, the routes and the shrink guard. No browser.

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrapforai-tables-test-'));
process.env.SCRAPFORAI_API_KEY = 'test-api-key-1234567890';
process.env.SCRAPFORAI_DATA_DIR = dataDir;
process.env.ARTIFACT_DIR = path.join(dataDir, 'artifacts');
process.env.ALLOWED_TARGET_ORIGINS = 'https://dev.example.com';

const express = (await import('express')).default;
const { parseCaseTable, columnOf, CaseTableError } = await import('../src/tables/caseTable.js');
const { saveTableVersion, getTable, listVersions, listTables, tableDigest } = await import('../src/tables/caseTableLibrary.js');
const { saveCaseTable } = await import('../src/tables/caseTableService.js');
const { resolveTables } = await import('../src/tables/resolveTables.js');
const { tablesRouter } = await import('../src/routes/tables.routes.js');
const { explorationRequestSchema } = await import('../src/schemas/explorationRequest.schema.js');
const { resolveExplorationRequest, RequestResolutionError } = await import('../src/runner/resolveRequest.js');
const { saveRoutine } = await import('../src/library/routineService.js');
const { saveTarget } = await import('../src/targets/targetStore.js');
const { checkAssertEquals } = await import('../src/oracle/assertEquals.js');
const { saveCredentialSet } = await import('../src/vault/credentials/credentialVault.js');
const { caseTableDir } = await import('../src/config/paths.js');

let api: http.Server;
let apiUrl: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/v1/tables', tablesRouter);
  api = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => api.once('listening', resolve));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => api.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ---- the reader

test('csv: header, rows, quoting, a line break and a quote inside a cell', () => {
  const table = parseCaseTable('qty,price,note\n1,10.5,"a, b"\n2,3,"say ""hi"""\n3,4,"two\nlines"\n');
  assert.deepEqual(table.columns, ['qty', 'price', 'note']);
  assert.deepEqual(table.rows, [['1', '10.5', 'a, b'], ['2', '3', 'say "hi"'], ['3', '4', 'two\nlines']]);
  assert.deepEqual(columnOf(table, 'qty'), ['1', '2', '3']);
});

test('csv: CRLF, a BOM, blank lines, spaces around unquoted cells, no final newline', () => {
  const table = parseCaseTable('﻿qty , total\r\n\r\n 1 , 10 \r\n2,20');
  assert.deepEqual(table.columns, ['qty', 'total']);
  assert.deepEqual(table.rows, [['1', '10'], ['2', '20']]);
});

test('csv: a semicolon table (as a Portuguese or Spanish spreadsheet saves it) keeps a decimal comma', () => {
  const table = parseCaseTable('qty;total\n1;1.234,56\n2;"7,5"\n');
  assert.deepEqual(table.rows, [['1', '1.234,56'], ['2', '7,5']]);
});

test('csv: a quoted cell is kept as written, including its spaces', () => {
  assert.deepEqual(parseCaseTable('a,b\n" x ",y\n').rows, [[' x ', 'y']]);
});

test('csv: refusals name the line', () => {
  const refused = (csv: string, pattern: RegExp) => assert.throws(() => parseCaseTable(csv), (error: unknown) => error instanceof CaseTableError && pattern.test(error.message));
  refused('', /empty/);
  refused('a,b\n', /no case/);
  refused('a,b\n1,2\n3\n', /line 3: has 1 cell\(s\) but the header has 2/);
  refused('a,b\n1,"2\n', /line 2: a quoted cell is never closed/);
  refused('a,a\n1,2\n', /appears twice/);
  refused('a b,c\n1,2\n', /cannot be a column/);
  refused('a,b\n"x"y,2\n', /text after the closing quote/);
  refused(`a\n${'1\n'.repeat(501)}`, /more than 500 cases/);
  refused(Array.from({ length: 21 }, (_, i) => `c${i}`).join(',') + '\n' + Array.from({ length: 21 }, () => '1').join(','), /more than 20 columns/);
});

test('csv: a column that does not exist is an error that lists the real ones', () => {
  assert.throws(() => columnOf(parseCaseTable('a,b\n1,2\n'), 'z'), /no column "z" \(columns: a, b\)/);
});

// ---- the library

test('library: versions are immutable and numbered, an identical save makes no new version, line ends do not count', async () => {
  const first = await saveTableVersion('prices', { title: 'Prices', csv: 'qty,total\n1,10\n2,20\n' });
  assert.equal(first.created, true);
  assert.equal(first.table.version, 1);
  assert.deepEqual(first.table.columns, ['qty', 'total']);
  assert.equal(first.table.rowCount, 2);

  const same = await saveTableVersion('prices', { title: 'Prices', csv: 'qty,total\r\n1,10\r\n2,20' });
  assert.equal(same.created, false, 'the same table saved from another editor is not a new version');
  assert.equal(same.table.version, 1);

  const second = await saveTableVersion('prices', { title: 'Prices', csv: 'qty,total\n1,10\n2,20\n3,30\n' });
  assert.equal(second.table.version, 2);
  assert.deepEqual(await listVersions('prices'), [1, 2]);
  assert.equal((await getTable('prices'))?.version, 2, 'current is the newest');
  assert.equal((await getTable('prices', 1))?.rowCount, 2, 'a pinned version still reads as it was');
  assert.equal(await getTable('prices', 9), undefined);
  assert.ok((await listTables()).some((entry) => entry.id === 'prices' && entry.version === 2 && entry.rowCount === 3));
});

test('library: a version edited by hand fails its integrity check', async () => {
  await saveTableVersion('tamper', { csv: 'a\n1\n' });
  const file = path.join(caseTableDir(), 'tamper', 'v1.json');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"a\\n1\\n"', '"a\\n999\\n"'));
  await assert.rejects(() => getTable('tamper'), (error: { status?: number; name?: string }) => error.status === 500 && error.name === 'TableIntegrityError');
});

test('library: an unreadable table is a 400 that names the line, and a bad id is refused', async () => {
  await assert.rejects(() => saveTableVersion('broken', { csv: 'a,b\n1\n' }), (error: { status?: number; message?: string }) => error.status === 400 && /line 2/.test(error.message ?? ''));
  await assert.rejects(() => saveTableVersion('../x', { csv: 'a\n1\n' }), (error: { status?: number }) => error.status === 400);
  assert.notEqual(tableDigest('a', { csv: 'x\n1\n' }), tableDigest('b', { csv: 'x\n1\n' }), 'the id is part of the digest');
});

// ---- the lint

test('lint: a secret in a cell is refused with its row and column, and the text is never echoed', async () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk';
  await assert.rejects(
    () => saveCaseTable('leaky', { csv: `qty,token\n1,ok\n2,${jwt}\n` }),
    (error: { status?: number; name?: string; details?: Array<{ path: string; message: string }>; message?: string }) =>
      error.status === 422 && error.name === 'TableLintError' && error.details?.[0]?.path === 'rows.2.token' && !JSON.stringify(error).includes(jwt),
  );
  assert.equal(await getTable('leaky'), undefined, 'nothing is stored');

  await saveCredentialSet('tables-vault', { boundOrigins: ['https://dev.example.com'], values: { pass: 'Tr0ub4dor-and-more-8821' }, tags: [] }, 'create');
  await assert.rejects(
    () => saveCaseTable('leaky2', { csv: 'note\nTr0ub4dor-and-more-8821\n' }),
    (error: { status?: number; name?: string }) => error.status === 422 && error.name === 'TableLintError',
  );
});

// ---- the resolution

const parameters = [{ name: 'qty', fromTable: { id: 'calc', column: 'qty' } }, { name: 'price', fromTable: { id: 'calc', column: 'price' } }];
const expectation = { id: 'check', action: 'assertEquals', actual: { extracted: 'total' }, expected: { table: { id: 'calc', column: 'total' } }, locale: 'en' };

test('resolve: a column becomes the cases of its parameter and the expectation becomes the cell of the sample row (wrapping)', async () => {
  await saveTableVersion('calc', { csv: 'qty,price,total\n1,10,10\n2,10,20\n3,10,30\n' });
  const resolved = await resolveTables({ steps: [{ action: 'goto' }, expectation] as never[], parameters: parameters as never[], sample: 1 });
  assert.deepEqual(resolved.parameters, [
    { name: 'qty', cases: ['1', '2', '3'] },
    { name: 'price', cases: ['10', '10', '10'] },
  ]);
  assert.deepEqual((resolved.steps[1] as { expected: unknown }).expected, { value: '20' }, 'row 1 of the table');
  assert.deepEqual(resolved.tables, [{ id: 'calc', version: 1, sha256: (await getTable('calc'))!.sha256, rows: 3 }]);

  const wrapped = await resolveTables({ steps: [expectation] as never[], parameters: parameters as never[], sample: 4 });
  assert.deepEqual((wrapped.steps[0] as { expected: unknown }).expected, { value: '20' }, 'sample 4 of 3 rows is row 1, as with any cases');
});

test('resolve: with no table nothing changes, and a table inside a parallel branch or a teardown is found', async () => {
  const plain = { steps: [{ action: 'goto' }] as never[] };
  const untouched = await resolveTables(plain);
  assert.equal(untouched.steps, plain.steps);
  assert.equal(untouched.tables, undefined);

  const nested = await resolveTables({
    steps: [{ action: 'parallel', branches: [[expectation], [{ action: 'goto' }]] }] as never[],
    teardown: [expectation] as never[],
    parameters: parameters as never[],
    sample: 2,
  });
  const block = nested.steps[0] as unknown as { branches: Array<Array<{ expected: unknown }>> };
  assert.deepEqual(block.branches[0]![0]!.expected, { value: '30' });
  assert.deepEqual((nested.teardown![0] as { expected: unknown }).expected, { value: '30' });
});

test('resolve: a version can be pinned, the current one is used otherwise, and the result says which', async () => {
  await saveTableVersion('pin', { csv: 'qty,total\n1,10\n' });
  await saveTableVersion('pin', { csv: 'qty,total\n1,11\n' });
  const ask = (version?: number) => ({ steps: [{ ...expectation, expected: { table: { id: 'pin', column: 'total', ...(version ? { version } : {}) } } }] as never[] });
  assert.deepEqual(((await resolveTables(ask(1))).steps[0] as { expected: unknown }).expected, { value: '10' });
  const current = await resolveTables(ask());
  assert.deepEqual((current.steps[0] as { expected: unknown }).expected, { value: '11' });
  assert.equal(current.tables?.[0]?.version, 2);
});

test('resolve: a missing table or column, tables of different length, and parameterValues are refused before any browser starts', async () => {
  const refused = (input: Parameters<typeof resolveTables>[0], status: number, type: string) =>
    assert.rejects(() => resolveTables(input), (error: unknown) => error instanceof RequestResolutionError && error.status === status && error.name === type);

  await refused({ steps: [], parameters: [{ name: 'q', fromTable: { id: 'nope', column: 'qty' } }] as never[] }, 404, 'TableNotFound');
  await refused({ steps: [], parameters: [{ name: 'q', fromTable: { id: 'calc', version: 9, column: 'qty' } }] as never[] }, 404, 'TableNotFound');
  await refused({ steps: [], parameters: [{ name: 'q', fromTable: { id: 'calc', column: 'zzz' } }] as never[] }, 400, 'TableColumnNotFound');
  await refused({ steps: [], parameters: parameters as never[], hasFixedValues: true }, 400, 'TableWithFixedValues');

  await saveTableVersion('short', { csv: 'x\n1\n2\n' });
  await refused({ steps: [], parameters: [parameters[0], { name: 'x', fromTable: { id: 'short', column: 'x' } }] as never[] }, 400, 'TableRowMismatch');
});

test('request: the schema accepts the references and a typo in them is refused', () => {
  const base = { targetUrl: 'https://dev.example.com/app', parameters, steps: [{ action: 'goto', url: '/' }, { action: 'extractText', name: 'total', selector: '#t' }, expectation] };
  assert.ok(explorationRequestSchema.safeParse(base).success);
  assert.ok(!explorationRequestSchema.safeParse({ ...base, parameters: [{ name: 'q', fromTable: { id: 'calc' } }] }).success, 'a column is required');
  assert.ok(!explorationRequestSchema.safeParse({ ...base, parameters: [{ name: 'q', fromTable: { id: 'calc', column: 'a', extra: 1 } }] }).success, 'strict');
  assert.ok(!explorationRequestSchema.safeParse({ ...base, steps: [{ ...expectation, expected: { table: { id: 'calc' } } }] }).success);
});

test('resolveExplorationRequest: the run gets cases, a literal expectation, the record and the tables it read', async () => {
  const request = explorationRequestSchema.parse({
    targetUrl: 'https://dev.example.com/app',
    sample: 2,
    parameters,
    steps: [{ id: 'type', action: 'fill', selector: '#qty', valueFromParameter: 'qty' }, { id: 'read', action: 'extractText', name: 'total', selector: '#t' }, expectation],
  });
  const resolved = await resolveExplorationRequest(request, { initiator: 'system' });
  assert.equal(resolved.parameterRecord?.values.qty, '3');
  assert.equal(resolved.parameterRecord?.values.price, '10');
  assert.equal(resolved.parameterRecord?.sources.qty?.source, 'case');
  assert.equal(resolved.parameterRecord?.sources.qty?.index, 2, 'the sample is the row');
  assert.deepEqual((resolved.steps[2] as { expected: unknown }).expected, { value: '30' });
  assert.equal(resolved.tables?.[0]?.rows, 3);
  assert.deepEqual(resolved.parameters, parameters, 'the request keeps the references as written (a saved routine keeps them)');

  await assert.rejects(
    () => resolveExplorationRequest(explorationRequestSchema.parse({ ...request, parameterValues: { qty: '1' } }), { initiator: 'system' }),
    (error: unknown) => error instanceof RequestResolutionError && error.name === 'TableWithFixedValues',
  );
});

// ---- the verdict, with the cell read in the step's locale

test('verdict: the expected cell is read with the step locale, so 1.234,56 is a number in pt', () => {
  const run = (actual: string, expected: string, locale: 'en' | 'pt') =>
    checkAssertEquals({ actual: { extracted: 'total' }, expected: { value: expected }, locale, parameters: {}, extracted: { total: actual } });
  assert.equal(run('1.234,56', '1.234,56', 'pt').passed, true);
  assert.throws(() => run('1.234,56', '1234.56', 'pt'), /"1234\.56" is not a number in the "pt" format/, 'a cell in the wrong locale is refused, never guessed');
  assert.equal(run('1,234.56', '1,234.56', 'en').passed, true);
});

// ---- a saved routine keeps the references, and checks them

test('routine: saving checks the table and the column, and keeps the reference (not the cells) in the stored version', async () => {
  await saveTarget({
    id: 'app', name: 'App', platform: 'generic', environment: 'dev', baseUrl: 'https://dev.example.com', credentialSets: [], noiseFilters: [], surfaces: {}, screens: [],
    flags: { allowDestructive: false, allowFaults: false, maxSessionsPerCredential: 1 },
  } as never);
  const steps = [{ id: 'open', action: 'goto', url: '$targetUrl' }, { id: 'type', action: 'fill', selector: '#qty', valueFromParameter: 'qty' }, { id: 'read', action: 'extractText', name: 'total', selector: '#t' }, expectation];
  const good = await saveRoutine('calc-routine', { title: 'calc', targetProfile: 'app', steps, parameters } as never);
  assert.equal(good.created, true);
  assert.deepEqual((good.routine as { parameters: unknown }).parameters, parameters);

  await assert.rejects(
    () => saveRoutine('calc-bad', { title: 'calc', targetProfile: 'app', steps, parameters: [{ name: 'qty', fromTable: { id: 'calc', column: 'missing' } }] } as never),
    (error: { status?: number; name?: string }) => error.status === 400 && error.name === 'TableColumnNotFound',
  );
  await assert.rejects(
    () => saveRoutine('calc-bad2', { title: 'calc', targetProfile: 'app', steps, parameters: [{ name: 'qty', fromTable: { id: 'ghost', column: 'qty' } }] } as never),
    (error: { status?: number; name?: string }) => error.status === 404 && error.name === 'TableNotFound',
  );
});

// ---- the routes

async function call(method: string, urlPath: string, body?: unknown) {
  const response = await fetch(`${apiUrl}${urlPath}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* csv */
  }
  return { status: response.status, text, json, type: response.headers.get('content-type') ?? '' };
}

test('routes: save (201 then 200 when identical), read, list, csv, versions and the errors', async () => {
  const created = await call('PUT', '/v1/tables/http-one', { title: 'One', csv: 'a,b\n1,2\n' });
  assert.equal(created.status, 201);
  assert.equal(created.json.table.version, 1);
  const again = await call('PUT', '/v1/tables/http-one', { title: 'One', csv: 'a,b\n1,2\n' });
  assert.equal(again.status, 200);
  assert.equal(again.json.created, false);

  const read = await call('GET', '/v1/tables/http-one');
  assert.equal(read.status, 200);
  assert.deepEqual(read.json.versions, [1]);
  const csv = await call('GET', '/v1/tables/http-one?format=csv');
  assert.match(csv.type, /text\/csv/);
  assert.equal(csv.text, 'a,b\n1,2\n');
  assert.ok((await call('GET', '/v1/tables')).json.tables.some((entry: { id: string }) => entry.id === 'http-one'));

  assert.equal((await call('GET', '/v1/tables/nope')).status, 404);
  assert.equal((await call('GET', '/v1/tables/http-one?version=abc')).status, 400);
  assert.equal((await call('GET', '/v1/tables/http-one?version=7')).status, 404);
  const bad = await call('PUT', '/v1/tables/http-two', { csv: 'a,b\n1\n' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.type, 'InvalidCaseTable');
  assert.equal((await call('PUT', '/v1/tables/http-three', { csv: '' })).status, 400);
  assert.equal((await call('PUT', '/v1/tables/http-four', { csv: 'a\n1\n', extra: true })).status, 400, 'the body is strict');
});
