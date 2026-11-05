import { createHash } from 'node:crypto';

import type { BugSignature } from '../schemas/bugReport.schema.js';

/**
 * T9.1 deduplication. Two failures are "the same bug" when the same routine fails at the same step with the same kind of error
 * (the roadmap's rule). It is the shrink's notion of "the same failure" (T5.6, `signatureOf`) plus WHICH routine. Not part of it, on purpose:
 *   - the routine VERSION (a new version that still fails at that step is the same open problem),
 *   - the target profile and the build (the same bug on dev and on staging is one bug; each occurrence records where it was seen),
 *   - the error MESSAGE (it carries values: a number, a name, a date, so it would split one bug into many).
 * Pure: no I/O, no configuration.
 */

export interface FailureParts {
  /** The library routine id; for a run that is not a routine, its scenario name. */
  routineId?: string;
  scenarioName: string;
  stepId: string;
  action?: string;
  errorType: string;
}

export function bugSignature(parts: FailureParts): BugSignature {
  const subject = parts.routineId ?? `scenario:${parts.scenarioName}`;
  const key = `${subject} / step ${parts.stepId} / ${parts.errorType}`;
  // The hash is over unambiguous separators (a newline cannot be in an id), so two different triples never collide by concatenation.
  const hash = createHash('sha256').update([subject, parts.stepId, parts.errorType].join('\n')).digest('hex').slice(0, 16);
  return {
    hash,
    key,
    subject,
    stepId: parts.stepId,
    ...(parts.action ? { action: parts.action } : {}),
    errorType: parts.errorType,
  };
}
