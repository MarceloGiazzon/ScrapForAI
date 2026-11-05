import { Router, type Response } from 'express';
import { ZodError } from 'zod';

import { CaseTableLibraryError, getTable, listTables, listVersions, tableContentSchema } from '../tables/caseTableLibrary.js';
import { saveCaseTable } from '../tables/caseTableService.js';

/** /v1/tables: the library of tables of cases, CSV inputs with their expected results (T5.5). Versioned and immutable like routines. */
export const tablesRouter = Router();

function sendKnownError(res: Response, error: unknown): boolean {
  if (error instanceof CaseTableLibraryError) {
    res.status(error.status).json({ error: { type: error.name, message: error.message, ...(error.details ? { details: error.details } : {}) } });
    return true;
  }
  if (error instanceof ZodError) {
    res.status(400).json({
      error: { type: 'ValidationError', message: 'Invalid request', details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) },
    });
    return true;
  }
  return false;
}

/** `?version=N`: a positive integer, or undefined when absent. Anything else is a 400. */
function parseVersion(value: unknown): number | undefined | 'invalid' {
  if (value === undefined) return undefined;
  return typeof value === 'string' && /^[1-9]\d{0,8}$/.test(value) ? Number(value) : 'invalid';
}

tablesRouter.get('/', async (_req, res, next) => {
  try {
    res.json({ tables: await listTables() });
  } catch (error) {
    if (!sendKnownError(res, error)) next(error);
  }
});

/** GET /v1/tables/:id[?version=N][&format=csv] - the stored table (current version by default), or just its CSV. */
tablesRouter.get('/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const version = parseVersion(req.query.version);
    if (version === 'invalid') {
      res.status(400).json({ error: { type: 'ValidationError', message: 'version must be a positive integer', details: [] } });
      return;
    }
    const table = await getTable(id, version);
    if (!table) {
      res.status(404).json({ error: { type: 'TableNotFound', message: version === undefined ? `Table "${id}" does not exist` : `Table "${id}" has no version ${version}` } });
      return;
    }
    if (req.query.format === 'csv') {
      res.type('text/csv').send(table.csv);
      return;
    }
    res.json({ table, versions: await listVersions(id) });
  } catch (error) {
    if (!sendKnownError(res, error)) next(error);
  }
});

/** PUT /v1/tables/:id { title?, csv } - stores the next version (nothing is written when the content is the current one). */
tablesRouter.put('/:id', async (req, res, next) => {
  try {
    const content = tableContentSchema.parse(req.body);
    const { table, created } = await saveCaseTable(String(req.params.id), content);
    res.status(created ? 201 : 200).json({ table, created });
  } catch (error) {
    if (!sendKnownError(res, error)) next(error);
  }
});
