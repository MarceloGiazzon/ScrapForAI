import { lintCaseTable } from '../library/routineLint.js';
import { listAllCredentialValues } from '../vault/credentials/credentialVault.js';
import { CaseTableError, parseCaseTable } from './caseTable.js';
import { CaseTableLibraryError, normalizeCsv, saveTableVersion, type TableContent } from './caseTableLibrary.js';

/**
 * T5.5: saves a table of cases. The CSV is read first (a table that cannot be read is a 400 naming the line), then every cell is checked
 * against the credential vault and the shapes of well-known secrets, like a routine (a table is stored in the library, maybe in git): a hit
 * is a 422 `TableLintError` that names the row and column but never echoes the text.
 */
export async function saveCaseTable(id: string, content: TableContent, createdBy?: string) {
  let parsed;
  try {
    parsed = parseCaseTable(normalizeCsv(content.csv));
  } catch (error) {
    if (error instanceof CaseTableError) throw new CaseTableLibraryError(400, 'InvalidCaseTable', error.message);
    throw error;
  }
  const issues = lintCaseTable(parsed, await listAllCredentialValues());
  if (issues.length > 0) throw new CaseTableLibraryError(422, 'TableLintError', 'The table contains what looks like a secret', issues);
  return saveTableVersion(id, content, createdBy);
}
