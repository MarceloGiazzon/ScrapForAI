import { RequestResolutionError } from '../runner/resolutionError.js';
import type { Parameter, TableRef } from '../schemas/parameters.schema.js';
import { leafSteps, mapLeaves } from '../schemas/stepTree.js';
import { columnOf, type ParsedTable } from './caseTable.js';
import { getTable, tableData } from './caseTableLibrary.js';

/**
 * T5.5: from "this run refers to columns of stored tables" to "these are the values of each column". Done by the server BEFORE the run,
 * after the includes are expanded, so the runner and the generators only ever see ordinary `cases` and a literal `value`:
 *
 *  - a parameter `{ name, fromTable: { id, version?, column } }` becomes `{ name, cases: <that column> }`;
 *  - an `assertEquals` with `expected: { table: { id, version?, column } }` becomes `expected: { value: <the cell of row `sample`> }`.
 *
 * The row is the run's `sample` (default 0, wrapping past the last row like any `cases`), so the inputs of a row and its expected result
 * are always the same line. Without `version` the CURRENT version is read, and the version actually used is returned (and recorded in the
 * result) so a proof says which table it ran against. With no table anywhere the input comes back untouched.
 */

export interface TableUse {
  id: string;
  version: number;
  sha256: string;
  rows: number;
}

interface StepLike {
  action: string;
  expected?: unknown;
}

export interface ResolveTablesInput<T extends StepLike> {
  steps: T[];
  teardown?: T[];
  parameters?: Parameter[];
  sample?: number;
  /** `parameterValues` were given (a shrink probe): they would no longer match the row's expected result. */
  hasFixedValues?: boolean;
}

export interface ResolveTablesOutput<T extends StepLike> {
  steps: T[];
  teardown?: T[];
  parameters?: Parameter[];
  /** Absent when the run uses no table. */
  tables?: TableUse[];
}

const isTableExpectation = (step: StepLike): step is StepLike & { expected: { table: TableRef } } =>
  step.action === 'assertEquals' && typeof step.expected === 'object' && step.expected !== null && 'table' in step.expected;

/** The table references of a run, in order of first use. */
export function tableRefsOf(parameters: readonly Parameter[], steps: readonly StepLike[]): TableRef[] {
  const refs: TableRef[] = [];
  for (const parameter of parameters) if ('fromTable' in parameter) refs.push(parameter.fromTable);
  for (const step of leafSteps(steps)) if (isTableExpectation(step)) refs.push(step.expected.table);
  return refs;
}

/** One table is read once per run (by id and requested version); each reference then takes ITS column from it. */
const tableKeyOf = (ref: TableRef): string => `${ref.id}@${ref.version ?? 'current'}`;

/** Loads the table a reference names. Throws the 404 the caller reports. */
async function loadTable(ref: TableRef): Promise<{ use: TableUse; data: ParsedTable }> {
  const table = await getTable(ref.id, ref.version);
  if (!table) {
    throw new RequestResolutionError(404, 'TableNotFound', ref.version === undefined ? `Table "${ref.id}" does not exist` : `Table "${ref.id}" has no version ${ref.version}`);
  }
  const data = tableData(table);
  return { use: { id: table.id, version: table.version, sha256: table.sha256, rows: data.rows.length }, data };
}

/** The values of the column a reference names. Throws the 400 when the table has no such column. */
function columnValues(ref: TableRef, loaded: { use: TableUse; data: ParsedTable }): string[] {
  if (!loaded.data.columns.includes(ref.column)) {
    throw new RequestResolutionError(400, 'TableColumnNotFound', `Table "${ref.id}" v${loaded.use.version} has no column "${ref.column}" (columns: ${loaded.data.columns.join(', ')})`);
  }
  return columnOf(loaded.data, ref.column);
}

/** Loads one reference: the table, checked to have the column. Throws the 404/400 the caller reports. */
export async function loadTableRef(ref: TableRef): Promise<{ use: TableUse; data: ParsedTable; values: string[] }> {
  const loaded = await loadTable(ref);
  return { ...loaded, values: columnValues(ref, loaded) };
}

export async function resolveTables<T extends StepLike>(input: ResolveTablesInput<T>): Promise<ResolveTablesOutput<T>> {
  const parameters = input.parameters ?? [];
  const refs = tableRefsOf(parameters, [...input.steps, ...(input.teardown ?? [])]);
  if (refs.length === 0) return { steps: input.steps, ...(input.teardown ? { teardown: input.teardown } : {}), ...(input.parameters ? { parameters: input.parameters } : {}) };

  if (input.hasFixedValues) {
    throw new RequestResolutionError(
      400,
      'TableWithFixedValues',
      'parameterValues cannot be used with a table of cases: a row is one case with its own expected result, and another value for a column would no longer match it',
    );
  }

  const loaded = new Map<string, Awaited<ReturnType<typeof loadTable>>>();
  for (const ref of refs) {
    const key = tableKeyOf(ref);
    if (!loaded.has(key)) loaded.set(key, await loadTable(ref));
    columnValues(ref, loaded.get(key)!); // every column named must exist, before anything is rewritten
  }
  const valuesOf = (ref: TableRef): string[] => columnValues(ref, loaded.get(tableKeyOf(ref))!);

  // Two tables are read row by row at the same time (one `sample` picks the row of each), so they must be the same length.
  const uses = [...new Map([...loaded.values()].map((entry) => [`${entry.use.id}@${entry.use.version}`, entry.use])).values()];
  if (new Set(uses.map((use) => use.rows)).size > 1) {
    throw new RequestResolutionError(
      400,
      'TableRowMismatch',
      `The tables of this run have different numbers of cases (${uses.map((use) => `${use.id} v${use.version}: ${use.rows}`).join(', ')}): a sample picks the same row of each, so they must match`,
    );
  }

  const sample = input.sample ?? 0;
  const rewriteStep = (step: T): T => {
    if (!isTableExpectation(step)) return step;
    const values = valuesOf(step.expected.table);
    return { ...step, expected: { value: values[sample % values.length]! } };
  };

  return {
    steps: mapLeaves(input.steps, rewriteStep, 's'),
    ...(input.teardown ? { teardown: mapLeaves(input.teardown, rewriteStep, 't') } : {}),
    parameters: parameters.map((parameter) => ('fromTable' in parameter ? { name: parameter.name, cases: valuesOf(parameter.fromTable) } : parameter)),
    tables: uses,
  };
}
