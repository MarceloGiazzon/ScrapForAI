/**
 * T5.5 (case tables): the CSV of a table of cases, parsed by hand. Pure: no configuration, no I/O.
 *
 * A table is a header row plus data rows. Each column is a name (the same rule as a parameter name) and each row is ONE case: a run's
 * `sample` index picks the row, so the inputs a row gives (`parameters: [{ name, fromTable }]`) and the result it expects
 * (`assertEquals expected: { table }`) always come from the same line.
 *
 * Accepted: RFC 4180 quoting (`"a,b"`, `""` for a quote, a line break inside quotes), CRLF/LF/CR line ends, a leading BOM, `,` or `;`
 * as the delimiter (a Spanish/Portuguese spreadsheet saves with `;`; it is taken from the header line), blank lines (skipped).
 * Unquoted cells are trimmed, quoted ones are kept as written. Refused, with the line: a row of another width, an unterminated quote,
 * a column name a parameter could not have, a duplicated column, no data row.
 */

export const MAX_TABLE_ROWS = 500; // the same as the `cases` of a parameter, which a column becomes
export const MAX_TABLE_COLUMNS = 20;
export const MAX_CELL_CHARS = 5000; // the same as a case
export const MAX_CSV_CHARS = 200_000;
export const COLUMN_NAME = /^[a-zA-Z0-9_-]{1,80}$/;

export class CaseTableError extends Error {
  constructor(
    message: string,
    readonly line?: number,
  ) {
    super(line === undefined ? message : `line ${line}: ${message}`);
    this.name = 'CaseTableError';
  }
}

export interface ParsedTable {
  columns: string[];
  /** Data rows, each as wide as `columns`. */
  rows: string[][];
}

type Cell = { text: string; quoted: boolean };

/** Delimiter of the header line: `;` only when it appears there (outside quotes) more often than `,`. */
function detectDelimiter(text: string): ',' | ';' {
  let commas = 0;
  let semicolons = 0;
  let inQuotes = false;
  for (const char of text) {
    if (char === '"') inQuotes = !inQuotes;
    else if (char === '\n' && !inQuotes) break;
    else if (!inQuotes && char === ',') commas += 1;
    else if (!inQuotes && char === ';') semicolons += 1;
  }
  return semicolons > commas ? ';' : ',';
}

function tokenize(text: string, delimiter: string): Array<{ line: number; cells: Cell[] }> {
  const records: Array<{ line: number; cells: Cell[] }> = [];
  let cells: Cell[] = [];
  let current = '';
  let quoted = false;
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;

  const endCell = () => {
    cells.push({ text: quoted ? current : current.trim(), quoted });
    current = '';
    quoted = false;
  };
  const endRecord = () => {
    endCell();
    records.push({ line: recordLine, cells });
    cells = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === '\n') line += 1;
        current += char;
      }
      continue;
    }
    if (char === '"' && current.trim() === '' && !quoted) {
      // A quote opens a quoted cell only at its start; spaces before it are dropped.
      inQuotes = true;
      quoted = true;
      current = '';
    } else if (char === delimiter) {
      endCell();
    } else if (char === '\n') {
      endRecord();
      line += 1;
      recordLine = line;
    } else if (quoted) {
      // Text after the closing quote: only spaces are tolerated (`"a" ,b`).
      if (char.trim() !== '') throw new CaseTableError('text after the closing quote of a cell', line);
    } else {
      current += char;
    }
  }
  if (inQuotes) throw new CaseTableError('a quoted cell is never closed', recordLine);
  if (current !== '' || quoted || cells.length > 0) endRecord();
  return records;
}

export function parseCaseTable(csv: string): ParsedTable {
  if (csv.length > MAX_CSV_CHARS) throw new CaseTableError(`the table is over ${MAX_CSV_CHARS} characters`);
  const text = csv.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const records = tokenize(text, detectDelimiter(text)).filter((record) => !(record.cells.length === 1 && record.cells[0]!.text === '' && !record.cells[0]!.quoted));
  const [header, ...data] = records;
  if (!header) throw new CaseTableError('the table is empty: it needs a header row and at least one case');

  const columns = header.cells.map((cell) => cell.text);
  if (columns.length > MAX_TABLE_COLUMNS) throw new CaseTableError(`more than ${MAX_TABLE_COLUMNS} columns`, header.line);
  const seen = new Set<string>();
  for (const name of columns) {
    if (!COLUMN_NAME.test(name)) throw new CaseTableError(`"${name.slice(0, 40)}" cannot be a column: names are letters, digits, _ and - (1-80 characters)`, header.line);
    if (seen.has(name)) throw new CaseTableError(`column "${name}" appears twice`, header.line);
    seen.add(name);
  }
  if (data.length === 0) throw new CaseTableError('the table has a header but no case');
  if (data.length > MAX_TABLE_ROWS) throw new CaseTableError(`more than ${MAX_TABLE_ROWS} cases`);

  const rows = data.map((record) => {
    if (record.cells.length !== columns.length) {
      throw new CaseTableError(`has ${record.cells.length} cell(s) but the header has ${columns.length}`, record.line);
    }
    return record.cells.map((cell) => {
      if (cell.text.length > MAX_CELL_CHARS) throw new CaseTableError(`a cell is over ${MAX_CELL_CHARS} characters`, record.line);
      return cell.text;
    });
  });
  return { columns, rows };
}

/** The values of one column, in row order: what a parameter's `cases` become. Throws when the column does not exist. */
export function columnOf(table: ParsedTable, column: string): string[] {
  const index = table.columns.indexOf(column);
  if (index < 0) throw new CaseTableError(`has no column "${column}" (columns: ${table.columns.join(', ')})`);
  return table.rows.map((row) => row[index]!);
}
