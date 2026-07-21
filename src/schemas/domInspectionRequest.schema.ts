import { z } from 'zod';

import { env } from '../config/env.js';

export const domInspectionRequestSchema = z
  .object({
    targetUrl: z.string().url().max(2048),
    waitUntil: z.enum(['commit', 'domcontentloaded', 'load', 'networkidle']).default('domcontentloaded'),
    timeoutMs: z.number().int().positive().max(env.STEP_TIMEOUT_MS).default(env.STEP_TIMEOUT_MS),
    includeRenderedHtml: z.boolean().default(false),
    includeHiddenControls: z.boolean().default(true),
    includeConsole: z.boolean().default(true),
    includeNetwork: z.boolean().default(false),
    redactSensitiveValues: z.boolean().default(true),
    viewport: z
      .object({
        width: z.number().int().min(50).max(4096),
        height: z.number().int().min(50).max(4096),
      })
      .strict()
      .optional(),
  })
  .strict();

export type DomInspectionRequest = z.infer<typeof domInspectionRequestSchema>;
