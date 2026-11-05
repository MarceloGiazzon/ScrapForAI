import { Router, type Response } from 'express';
import { z, ZodError } from 'zod';

import { BugReportError, dismissBugReport, draftBugReport, resolveBugReport, sendBugReport } from '../bugreport/service.js';
import { getBugReport, listBugReports } from '../bugreport/store.js';
import { requireBearer } from '../security/apiAuth.js';
import { BUG_REPORT_ID_PATTERN, type BugReport, bugReportRequestSchema, bugReportStatusSchema } from '../schemas/bugReport.schema.js';

/**
 * /v1/bug-reports (T9.1). A report is a DRAFT: making one starts no browser and sends nothing, so a UI session may do it. SENDING one puts data
 * outside this server, so it needs the bearer token: a person approves it by calling it. The text of a report is already cleaned when it is stored.
 */
export const bugReportsRouter = Router();

const noteSchema = z.object({ note: z.string().max(500).optional() }).strict();

function known(res: Response, error: unknown): boolean {
  if (error instanceof BugReportError) {
    res.status(error.status).json({ error: { type: error.name, message: error.message } });
    return true;
  }
  if (error instanceof ZodError) {
    res.status(400).json({ error: { type: 'ValidationError', message: 'Invalid request', details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) } });
    return true;
  }
  return false;
}

/** The list does not carry the body (it can be 60 KB each). */
const summaryOf = (report: BugReport): Omit<BugReport, 'body' | 'attempts' | 'occurrences'> & { lastAttempt?: BugReport['attempts'][number] } => {
  const { body: _body, attempts, occurrences: _occurrences, ...rest } = report;
  return { ...rest, ...(attempts.length > 0 ? { lastAttempt: attempts[attempts.length - 1]! } : {}) };
};

const idOf = (value: unknown): string | undefined => (BUG_REPORT_ID_PATTERN.test(String(value)) ? String(value) : undefined);
const notFound = (res: Response): void => void res.status(404).json({ error: { type: 'BugReportNotFound', message: 'Bug report not found' } });

bugReportsRouter.get('/', async (req, res, next) => {
  try {
    const status = typeof req.query.status === 'string' ? bugReportStatusSchema.safeParse(req.query.status) : undefined;
    if (status && !status.success) {
      res.status(400).json({ error: { type: 'ValidationError', message: `status must be one of ${bugReportStatusSchema.options.join(', ')}` } });
      return;
    }
    const limit = Number.parseInt(String(req.query.limit ?? ''), 10);
    const reports = await listBugReports({ ...(status?.success ? { status: status.data } : {}), ...(Number.isFinite(limit) && limit > 0 ? { limit: Math.min(limit, 500) } : {}) });
    res.json({ bugReports: reports.map(summaryOf) });
  } catch (error) {
    next(error);
  }
});

/** GET /v1/bug-reports/:id[?format=md] - the whole report; `md` is the issue as it would be sent (title, then body). */
bugReportsRouter.get('/:id', async (req, res, next) => {
  try {
    const id = idOf(req.params.id);
    const report = id ? await getBugReport(id) : undefined;
    if (!report) return notFound(res);
    if (req.query.format === 'md') {
      res.type('text/markdown; charset=utf-8').send(`# ${report.title}\n\n${report.body}`);
      return;
    }
    res.json(report);
  } catch (error) {
    next(error);
  }
});

/** POST /v1/bug-reports { fromJobId, shrinkId?, lang? }: 201 a new draft, 200 when the failure already had a report (its occurrence was added). */
bugReportsRouter.post('/', async (req, res, next) => {
  try {
    const outcome = await draftBugReport(bugReportRequestSchema.parse(req.body), { via: 'manual' });
    res.status(outcome.created ? 201 : 200).json({ ...outcome, report: outcome.report });
  } catch (error) {
    if (!known(res, error)) next(error);
  }
});

/**
 * POST /v1/bug-reports/:id/send { integrationId? } - the approval. 200 sent (the issue's number and address), 502 the tracker did not take it,
 * 422 the text still held a secret after cleaning and nothing was sent. In the last two the report stays a draft.
 */
bugReportsRouter.post('/:id/send', requireBearer, async (req, res, next) => {
  try {
    const id = idOf(req.params.id);
    if (!id) return notFound(res);
    const body = z.object({ integrationId: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/).optional() }).strict().parse(req.body ?? {});
    const { report, attempt } = await sendBugReport(id, body.integrationId ? { integrationId: body.integrationId } : {});
    const code = attempt.status === 'sent' ? 200 : attempt.status === 'blocked' ? 422 : 502;
    res.status(code).json({ status: attempt.status, attempt, report });
  } catch (error) {
    if (!known(res, error)) next(error);
  }
});

bugReportsRouter.post('/:id/dismiss', async (req, res, next) => {
  try {
    const id = idOf(req.params.id);
    if (!id) return notFound(res);
    res.json(await dismissBugReport(id, noteSchema.parse(req.body ?? {}).note));
  } catch (error) {
    if (!known(res, error)) next(error);
  }
});

bugReportsRouter.post('/:id/resolve', async (req, res, next) => {
  try {
    const id = idOf(req.params.id);
    if (!id) return notFound(res);
    res.json(await resolveBugReport(id, noteSchema.parse(req.body ?? {}).note));
  } catch (error) {
    if (!known(res, error)) next(error);
  }
});
