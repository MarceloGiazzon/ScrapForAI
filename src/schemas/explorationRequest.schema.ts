import { z } from 'zod';

import { env } from '../config/env.js';

const safeName = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
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

export const explorationStepSchema = z.discriminatedUnion('action', [
  gotoStep,
  reloadStep,
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
  extractTextStep,
  extractAttributeStep,
  evaluateStep,
  watchStep,
  waitForElapsedStep,
  setViewportSizeStep,
]);

export const explorationRequestSchema = z
  .object({
    scenarioName: z.string().min(1).max(160).optional(),
    targetUrl: z.string().url().max(2048),
    credentials: z.record(safeName, z.string().max(5000)).optional(),
    variables: z.record(safeName, z.string().max(5000)).optional(),
    caller: callerSchema.optional(),
    options: z
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
      })
      .strict()
      .default({ headless: true, trace: false, screenshots: 'onFailure', collectDomOnFailure: false }),
    steps: z.array(explorationStepSchema).min(1).max(env.MAX_STEPS_PER_JOB),
  })
  .strict()
  .superRefine((routine, ctx) => {
    const previousIds = new Set<string>();

    routine.steps.forEach((step, index) => {
      if (!env.ALLOW_EVALUATE && (step.action === 'evaluate' || step.action === 'watch')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['steps', index, 'action'],
          message: 'evaluate/watch are disabled (set ALLOW_EVALUATE=true)',
        });
      }

      if (step.action === 'waitForElapsed' && !previousIds.has(step.sinceStepId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['steps', index, 'sinceStepId'],
          message: `sinceStepId "${step.sinceStepId}" must match the id of an earlier step`,
        });
      }

      if (step.id) {
        if (previousIds.has(step.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['steps', index, 'id'],
            message: `duplicate step id "${step.id}"`,
          });
        }

        previousIds.add(step.id);
      }
    });
  });

export type ExplorationRequest = z.infer<typeof explorationRequestSchema>;
export type ExplorationStep = z.infer<typeof explorationStepSchema>;
export type ValueSource = z.infer<typeof valueSource>;
export type Caller = z.infer<typeof callerSchema>;
export type FrameRef = z.infer<typeof frameRefSchema>;
export type WaitCondition = z.infer<typeof waitConditionSchema>;
