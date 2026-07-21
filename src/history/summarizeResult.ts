import type { ExplorationResult } from '../schemas/explorationResult.schema.js';
import type { RunSummary } from './runSummary.js';

const MAX_ERROR_MESSAGE_CHARS = 500;

/**
 * Projects a full ExplorationResult down to the compact index record.
 *
 * The input has ALREADY been passed through redactSecrets() by runExploration, so no
 * further redaction is needed here. Do not add fields that could reintroduce bulk.
 */
export function summarizeResult(result: ExplorationResult): RunSummary {
  let passedSteps = 0;
  let failedSteps = 0;
  let skippedSteps = 0;

  for (const step of result.steps) {
    if (step.status === 'passed') {
      passedSteps += 1;
    } else if (step.status === 'failed') {
      failedSteps += 1;
    } else {
      skippedSteps += 1;
    }
  }

  return {
    jobId: result.jobId,
    scenarioName: result.scenarioName,
    status: result.status,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    targetUrl: result.targetUrl,

    // caller is nullable on the result schema, so optional chaining covers both null and
    // an absent caller block.
    callerSource: result.caller?.source,
    callerCorrelationId: result.caller?.correlationId,

    stepCount: result.steps.length,
    passedSteps,
    failedSteps,
    skippedSteps,
    failedStepIndex: result.failedStepIndex,

    errorType: result.error?.type,
    errorMessage: result.error?.message.slice(0, MAX_ERROR_MESSAGE_CHARS),

    screenshotCount: result.evidence.screenshots.length,
    consoleErrorCount: result.evidence.consoleErrors.length,
    networkFailureCount: result.evidence.networkFailures.length,
    unexpectedExternalRequestCount: result.evidence.unexpectedExternalRequests.length,

    artifactRelativeRoot: `artifacts/${result.jobId}`,
  };
}
