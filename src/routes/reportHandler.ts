import type { Request, Response } from 'express';

import { EvidenceError } from '../evidence/pin.js';
import { jobQueue } from '../runner/jobSlots.js';
import { buildRunReport, buildSuiteReportHtml, htmlToPdf } from '../reports/buildReport.js';
import { REPORT_LANGS, type ReportLang } from '../reports/i18n.js';

/**
 * Shared by GET /v1/runs/:jobId/report and GET /v1/suites/:id/report.
 * Query: format=html|pdf (default html), lang=en|pt|es (default en). A PDF needs a browser, so it takes an
 * interactive slot like any other browser job: 429 when none is free.
 */
export async function sendReport(req: Request, res: Response, kind: 'run' | 'suite', id: string): Promise<void> {
  const format = req.query.format === undefined ? 'html' : String(req.query.format);
  const lang = req.query.lang === undefined ? 'en' : String(req.query.lang);

  if (format !== 'html' && format !== 'pdf') {
    res.status(400).json({ error: { type: 'ValidationError', message: 'format must be html or pdf', details: [] } });
    return;
  }
  if (!(REPORT_LANGS as readonly string[]).includes(lang)) {
    res.status(400).json({ error: { type: 'ValidationError', message: `lang must be one of ${REPORT_LANGS.join(', ')}`, details: [] } });
    return;
  }

  try {
    const html = kind === 'run' ? await buildRunReport(id, lang as ReportLang) : await buildSuiteReportHtml(id, lang as ReportLang);

    if (format === 'html') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('content-disposition', `inline; filename="${id}.report.${lang}.html"`);
      res.send(html);
      return;
    }

    const slot = jobQueue.tryAcquire({ priority: 'interactive' });
    if (!slot.ok) {
      res.status(429).json({ error: { type: 'TooManyRequests', message: 'Too many browser jobs are running; a PDF needs one. Retry shortly.' } });
      return;
    }

    try {
      const pdf = await htmlToPdf(html);
      res.setHeader('content-type', 'application/pdf');
      res.setHeader('content-disposition', `attachment; filename="${id}.report.${lang}.pdf"`);
      res.send(pdf);
    } finally {
      slot.release();
    }
  } catch (error) {
    if (error instanceof EvidenceError) {
      res.status(error.status).json({ error: { type: error.name, message: error.message } });
      return;
    }
    throw error;
  }
}
