import { z } from 'zod';

import { env } from '../config/env.js';

export const safeName = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
/** Build/revision label of the application under test, e.g. "rev4519" or "2026.11/rc1". */
export const buildIdSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[\w.+\-/]+$/);
const stepId = z.string().min(1).max(80);
const selector = z.string().min(1).max(500);
const shortText = z.string().max(500);
const valueText = z.string().max(5000);
const stepTimeout = z.number().int().positive().max(env.STEP_TIMEOUT_MS).optional();

export const callerSchema = z
  .object({
    correlationId: z.string().max(200).optional(),
    source: z.string().max(200).optional(),
    metadata: z.record(z.string(), z.string().max(5000)).optional(),
  })
  .strict();

const frameRefSchema = z.union([
  z.object({ name: z.string().min(1).max(500) }).strict(),
  z.object({ urlContains: z.string().min(1).max(2048) }).strict(),
  z.object({ index: z.number().int().min(0) }).strict(),
]);

const waitConditionSchema = z
  .object({
    timeoutMs: z.number().int().min(0).max(60000).optional(),
    selector: z.string().min(1).max(500).optional(),
    state: z.enum(['attached', 'detached', 'visible', 'hidden']).optional(),
    response: z
      .object({
        urlContains: z.string().min(1).max(2048),
        status: z.number().int().min(100).max(599).optional(),
      })
      .strict()
      .optional(),
    loadState: z.enum(['load', 'domcontentloaded', 'networkidle']).optional(),
    urlContains: z.string().min(1).max(2048).optional(),
  })
  .strict()
  .superRefine((condition, ctx) => {
    const specifiedConditions = [condition.selector, condition.response, condition.loadState, condition.urlContains].filter(
      (value) => value !== undefined,
    );

    if (specifiedConditions.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'wait condition must specify exactly one of: selector, response, loadState, urlContains',
      });
    }

    if (condition.state !== undefined && condition.selector === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['state'],
        message: 'state is only valid with selector wait conditions',
      });
    }
  });

const baseStep = {
  id: stepId.optional(),
  label: z.string().min(1).max(160).optional(),
  description: z.string().min(1).max(500).optional(),
  frame: frameRefSchema.optional(),
  delayMs: z.number().int().min(0).max(60000).optional(),
  waitFor: waitConditionSchema.optional(),
  afterWaitFor: waitConditionSchema.optional(),
};

const valueSource = z.union([
  z.object({ value: valueText }).strict(),
  z.object({ valueFromCredential: safeName }).strict(),
  z.object({ valueFromVariable: safeName }).strict(),
]);

const valueFields = {
  value: valueText.optional(),
  valueFromCredential: safeName.optional(),
  valueFromVariable: safeName.optional(),
};

function withValueSource<T extends z.ZodRawShape>(shape: T) {
  return z
    .object({ ...baseStep, ...shape, ...valueFields })
    .strict()
    .refine(
      (step) => {
        const valueStep = step as { value?: string; valueFromCredential?: string; valueFromVariable?: string };
        return [valueStep.value, valueStep.valueFromCredential, valueStep.valueFromVariable].filter((value) => value !== undefined).length === 1;
      },
      {
        message: 'Exactly one value source is required',
      },
    );
}

const gotoStep = z
  .object({
    ...baseStep,
    action: z.literal('goto'),
    url: z.string().min(1).max(2048),
    timeoutMs: stepTimeout,
  })
  .strict();

const reloadStep = z.object({ ...baseStep, action: z.literal('reload'), timeoutMs: stepTimeout }).strict();
const setOfflineStep = z.object({ ...baseStep, action: z.literal('setOffline'), offline: z.boolean() }).strict();
const waitForLoadStateStep = z
  .object({
    ...baseStep,
    action: z.literal('waitForLoadState'),
    state: z.enum(['domcontentloaded', 'load', 'networkidle']),
    timeoutMs: stepTimeout,
  })
  .strict();
const waitForUrlContainsStep = z
  .object({ ...baseStep, action: z.literal('waitForUrlContains'), value: shortText, timeoutMs: stepTimeout })
  .strict();
const waitForTimeoutStep = z.object({ ...baseStep, action: z.literal('waitForTimeout'), timeoutMs: z.number().int().positive().max(env.STEP_TIMEOUT_MS) }).strict();
const setViewportStep = z
  .object({
    ...baseStep,
    action: z.literal('setViewport'),
    width: z.number().int().min(50).max(4096),
    height: z.number().int().min(50).max(4096),
  })
  .strict();

// Resizes the real browser window via CDP (Browser.setWindowBounds).
// Requires options.windowMode: true so the context was created with viewport: null.
// Unlike setViewport (CSS emulation only), this triggers framework layout recalculations
// (e.g. ExtJS onWindowResize) the same way a physical window drag does.
const resizeWindowStep = z
  .object({
    ...baseStep,
    action: z.literal('resizeWindow'),
    width: z.number().int().min(50).max(4096),
    height: z.number().int().min(50).max(4096),
  })
  .strict();

const fillStep = withValueSource({ action: z.literal('fill'), selector, timeoutMs: stepTimeout });
const clickStep = z.object({ ...baseStep, action: z.literal('click'), selector, timeoutMs: stepTimeout }).strict();
const doubleClickStep = z.object({ ...baseStep, action: z.literal('doubleClick'), selector, timeoutMs: stepTimeout }).strict();
const hoverStep = z.object({ ...baseStep, action: z.literal('hover'), selector, timeoutMs: stepTimeout }).strict();
const pressStep = z.object({ ...baseStep, action: z.literal('press'), selector, key: z.string().min(1).max(80), timeoutMs: stepTimeout }).strict();
const selectOptionStep = withValueSource({ action: z.literal('selectOption'), selector, timeoutMs: stepTimeout });
const checkStep = z.object({ ...baseStep, action: z.literal('check'), selector, timeoutMs: stepTimeout }).strict();
const uncheckStep = z.object({ ...baseStep, action: z.literal('uncheck'), selector, timeoutMs: stepTimeout }).strict();

const waitForSelectorStep = z
  .object({
    ...baseStep,
    action: z.literal('waitForSelector'),
    selector,
    state: z.enum(['attached', 'detached', 'visible', 'hidden']),
    timeoutMs: stepTimeout,
  })
  .strict();
const waitForResponseStep = z
  .object({
    ...baseStep,
    action: z.literal('waitForResponse'),
    urlContains: z.string().min(1).max(500),
    method: z.string().min(1).max(20).optional(),
    status: z.number().int().min(100).max(599).optional(),
    timeoutMs: stepTimeout,
  })
  .strict();
const assertVisibleStep = z.object({ ...baseStep, action: z.literal('assertVisible'), selector, timeoutMs: stepTimeout }).strict();
const assertHiddenStep = z.object({ ...baseStep, action: z.literal('assertHidden'), selector, timeoutMs: stepTimeout }).strict();
const assertEnabledStep = z.object({ ...baseStep, action: z.literal('assertEnabled'), selector, timeoutMs: stepTimeout }).strict();
const assertDisabledStep = z.object({ ...baseStep, action: z.literal('assertDisabled'), selector, timeoutMs: stepTimeout }).strict();
const assertTextContainsStep = z
  .object({ ...baseStep, action: z.literal('assertTextContains'), selector, text: valueText, timeoutMs: stepTimeout })
  .strict();
const assertUrlContainsStep = z.object({ ...baseStep, action: z.literal('assertUrlContains'), value: shortText }).strict();
const assertCountStep = z
  .object({
    ...baseStep,
    action: z.literal('assertCount'),
    selector,
    operator: z.enum(['=', '!=', '>', '>=', '<', '<=']),
    count: z.number().int().nonnegative(),
  })
  .strict();

const screenshotStep = z.object({ ...baseStep, action: z.literal('screenshot'), name: safeName }).strict();
const collectStep = z
  .object({
    ...baseStep,
    action: z.literal('collect'),
    what: z.array(z.enum(['console', 'network', 'domText', 'url', 'pageErrors'])).min(1).max(5),
  })
  .strict();
// T6.1: records the state of the page WITHOUT failing, so one run can answer "what does this role see here?".
// extracted[name] = { url, documentStatus, markersFound, selector?: { count, visible, enabled } }. Read-only: no
// click, no script of the caller's (the HTTP status comes from the browser's own navigation timing).
// With `selector` and `timeoutMs`, it waits up to timeoutMs for the selector to appear; absent is an answer, not an error.
const probePageStep = z
  .object({
    ...baseStep,
    action: z.literal('probePage'),
    name: safeName,
    selector: selector.optional(),
    textMarkers: z.array(z.string().min(1).max(500)).max(20).optional(),
    timeoutMs: stepTimeout,
  })
  .strict();
const extractTextStep = z.object({ ...baseStep, action: z.literal('extractText'), selector, name: safeName, timeoutMs: stepTimeout }).strict();
const extractAttributeStep = z
  .object({ ...baseStep, action: z.literal('extractAttribute'), selector, attribute: safeName, name: safeName, timeoutMs: stepTimeout })
  .strict();
const evaluateStep = z
  .object({
    ...baseStep,
    action: z.literal('evaluate'),
    name: safeName,
    script: z.string().min(1).max(env.MAX_EVALUATE_SCRIPT_CHARS),
  })
  .strict();
const watchStep = z
  .object({
    ...baseStep,
    action: z.literal('watch'),
    name: safeName,
    script: z.string().min(1).max(env.MAX_EVALUATE_SCRIPT_CHARS),
    intervalMs: z.number().int().min(env.MIN_WATCH_INTERVAL_MS).max(10000),
    durationMs: z.number().int().min(100).max(env.MAX_WATCH_DURATION_MS),
  })
  .strict();
const waitForElapsedStep = z
  .object({
    ...baseStep,
    action: z.literal('waitForElapsed'),
    sinceStepId: stepId,
    minElapsedMs: z.number().int().min(0).max(600000),
    timeoutMs: z.number().int().min(0).max(600000).optional(),
  })
  .strict();
const setViewportSizeStep = z
  .object({
    ...baseStep,
    action: z.literal('setViewportSize'),
    width: z.number().int().min(50).max(4096),
    height: z.number().int().min(50).max(4096),
  })
  .strict();

// T1.4: expands, server-side and before the run, into the steps of another library routine. Its id (or,
// without one, the routineId) prefixes the ids of the expanded steps: "login.submit". The runner never
// sees an include step. Pin `version` for a reproducible run; without it the CURRENT version is used,
// and the version actually used is recorded in the result.
const includeStep = z
  .object({
    id: stepId.optional(),
    label: z.string().min(1).max(160).optional(),
    description: z.string().min(1).max(500).optional(),
    action: z.literal('include'),
    routineId: safeName,
    version: z.number().int().positive().optional(),
  })
  .strict();

export const explorationStepSchema = z.discriminatedUnion('action', [
  includeStep,
  gotoStep,
  reloadStep,
  setOfflineStep,
  waitForLoadStateStep,
  waitForUrlContainsStep,
  waitForTimeoutStep,
  setViewportStep,
  resizeWindowStep,
  fillStep,
  clickStep,
  doubleClickStep,
  hoverStep,
  pressStep,
  selectOptionStep,
  checkStep,
  uncheckStep,
  waitForSelectorStep,
  waitForResponseStep,
  assertVisibleStep,
  assertHiddenStep,
  assertEnabledStep,
  assertDisabledStep,
  assertTextContainsStep,
  assertUrlContainsStep,
  assertCountStep,
  screenshotStep,
  collectStep,
  probePageStep,
  extractTextStep,
  extractAttributeStep,
  evaluateStep,
  watchStep,
  waitForElapsedStep,
  setViewportSizeStep,
]);

// The object BEFORE superRefine. Derived schemas (e.g. the MCP one, without `credentials`) must be
// built from this, not from the refined schema, so no validation is lost or broken.
export const explorationOptionsSchema = z
  .object({
    headless: z.boolean().default(true),
    trace: z.boolean().default(false),
    screenshots: z.enum(['off', 'onFailure', 'always']).default('onFailure'),
    collectDomOnFailure: z.boolean().default(false),
    viewport: z
      .object({
        width: z.number().int().min(50).max(4096),
        height: z.number().int().min(50).max(4096),
      })
      .strict()
      .optional(),
    // Evidence retention class (T1.5). Absent = ephemeral (ARTIFACT_RETENTION_HOURS). Pinning is a
    // separate, explicit action (POST /v1/runs/:jobId/pin), never an option of the run itself.
    retention: z.enum(['ephemeral', 'standard']).optional(),
  })
  .strict();

export const explorationRequestBaseSchema = z
  .object({
    scenarioName: z.string().min(1).max(160).optional(),
    // Optional only when `targetProfile` supplies a default (enforced in validateRoutine).
    targetUrl: z.string().url().max(2048).optional(),
    // Build/revision of the application under test (e.g. "rev4519"). Recorded in the result and in pinned evidence, so a
    // proof says WHICH build it proves. Until the target profile can probe it (T3.1), the caller supplies it.
    buildId: buildIdSchema.optional(),
    // T1.1: named target profile (src/targets). Its baseUrl is the default targetUrl.
    targetProfile: safeName.optional(),
    // Inline secret values. Deprecated: prefer `credentialSet`, whose values live in the server-side
    // vault (T1.2) and never pass through the caller. Not exposed on the MCP tool schema.
    credentials: z.record(safeName, z.string().max(5000)).optional(),
    // T1.2: id of a vault credential set. Its fields are loaded server-side into `credentials`.
    credentialSet: safeName.optional(),
    variables: z.record(safeName, z.string().max(5000)).optional(),
    caller: callerSchema.optional(),
    options: explorationOptionsSchema.default({ headless: true, trace: false, screenshots: 'onFailure', collectDomOnFailure: false }),
    steps: z.array(explorationStepSchema).min(1).max(env.MAX_STEPS_PER_JOB),
    // T1.4: always runs after the steps, pass or fail (like `finally`). Failures here are recorded
    // apart and never replace the failure of the steps. Steps + teardown share MAX_STEPS_PER_JOB.
    teardown: z.array(explorationStepSchema).min(1).max(env.MAX_STEPS_PER_JOB).optional(),
  })
  .strict();

type RoutineForValidation = {
  targetUrl?: string;
  targetProfile?: string;
  steps: Array<z.infer<typeof explorationStepSchema>>;
  teardown?: Array<z.infer<typeof explorationStepSchema>>;
};

function validateRoutine(routine: RoutineForValidation, ctx: z.RefinementCtx): void {
  if (routine.targetUrl === undefined && routine.targetProfile === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targetUrl'],
      message: 'targetUrl is required unless targetProfile is given',
    });
  }

  validateStepList(routine.steps, 'steps', ctx);

  if (routine.teardown) {
    validateStepList(routine.teardown, 'teardown', ctx);

    if (routine.steps.length + routine.teardown.length > env.MAX_STEPS_PER_JOB) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['teardown'],
        message: `steps + teardown exceed MAX_STEPS_PER_JOB (${env.MAX_STEPS_PER_JOB})`,
      });
    }
  }
}

/** Per-list checks: evaluate gating, forward references of waitForElapsed, duplicate ids. */
function validateStepList(steps: Array<z.infer<typeof explorationStepSchema>>, field: 'steps' | 'teardown', ctx: z.RefinementCtx): void {
  const previousIds = new Set<string>();

  steps.forEach((step, index) => {
    if (!env.ALLOW_EVALUATE && (step.action === 'evaluate' || step.action === 'watch')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field, index, 'action'],
        message: 'evaluate/watch are disabled (set ALLOW_EVALUATE=true)',
      });
    }

    if (step.action === 'waitForElapsed' && !previousIds.has(step.sinceStepId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field, index, 'sinceStepId'],
        message: `sinceStepId "${step.sinceStepId}" must match the id of an earlier step`,
      });
    }

    if (step.id) {
      if (previousIds.has(step.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field, index, 'id'],
          message: `duplicate step id "${step.id}"`,
        });
      }

      previousIds.add(step.id);
    }
  });
}

export const explorationRequestSchema = explorationRequestBaseSchema.superRefine(validateRoutine);

// What the MCP tool accepts: the same request minus inline `credentials`, so a model cannot
// supply secret values. (.strict() makes a stray `credentials` key a validation error.)
export const mcpExplorationRequestSchema = explorationRequestBaseSchema.omit({ credentials: true }).superRefine(validateRoutine);

export type ExplorationRequest = z.infer<typeof explorationRequestSchema>;
export type ExplorationStep = z.infer<typeof explorationStepSchema>;
/** A step the runner can execute: includes have already been expanded away (T1.4). */
export type RunnableStep = Exclude<ExplorationStep, { action: 'include' }>;
export type ValueSource = z.infer<typeof valueSource>;
export type Caller = z.infer<typeof callerSchema>;
export type FrameRef = z.infer<typeof frameRefSchema>;
export type WaitCondition = z.infer<typeof waitConditionSchema>;
