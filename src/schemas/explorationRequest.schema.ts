import { z } from 'zod';

import { env } from '../config/env.js';
import { MAX_EXPRESSION_CHARS, parseExpression } from '../oracle/expression.js';
import { A11Y_FAIL_ON, ACCESSIBILITY_STANDARDS } from './accessibility.schema.js';
import { checkedGeneratorSchema, parameterName, parametersSchema, parameterValuesSchema, sampleIndexSchema, seedSchema } from './parameters.schema.js';

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
  z.object({ valueFromParameter: parameterName }).strict(),
  z.object({ valueFromGenerator: checkedGeneratorSchema }).strict(),
]);

const valueFields = {
  value: valueText.optional(),
  valueFromCredential: safeName.optional(),
  valueFromVariable: safeName.optional(),
  // T5.3: a declared parameter of the run/routine, or an inline generator (sugar for a parameter of its own).
  valueFromParameter: parameterName.optional(),
  valueFromGenerator: checkedGeneratorSchema.optional(),
};

function withValueSource<T extends z.ZodRawShape>(shape: T) {
  return z
    .object({ ...baseStep, ...shape, ...valueFields })
    .strict()
    .refine(
      (step) => {
        const valueStep = step as Record<'value' | 'valueFromCredential' | 'valueFromVariable' | 'valueFromParameter' | 'valueFromGenerator', unknown>;
        return (
          [valueStep.value, valueStep.valueFromCredential, valueStep.valueFromVariable, valueStep.valueFromParameter, valueStep.valueFromGenerator].filter(
            (value) => value !== undefined,
          ).length === 1
        );
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

// T5.5: the formula oracle. Compares a number the page showed (`actual.extracted`, read earlier by extractText/...) with what it SHOULD show,
// either a formula over the run's parameters and extracted values (`expr`, see src/oracle/expression.ts: no eval) or a literal `value`.
// The text is parsed with `locale` (en 1,234.56 | pt/es 1.234,56). `tolerance` is absolute and/or relative; default: floating-point noise only.
const expectedExpression = z
  .string()
  .min(1)
  .max(MAX_EXPRESSION_CHARS)
  .superRefine((expr, ctx) => {
    try {
      parseExpression(expr);
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'invalid expression' });
    }
  });
const assertEqualsStep = z
  .object({
    ...baseStep,
    action: z.literal('assertEquals'),
    actual: z.object({ extracted: safeName }).strict(),
    expected: z.union([z.object({ expr: expectedExpression }).strict(), z.object({ value: z.string().min(1).max(100) }).strict()]),
    tolerance: z
      .object({ absolute: z.number().finite().nonnegative().optional(), relative: z.number().finite().nonnegative().optional() })
      .strict()
      .optional(),
    locale: z.enum(['en', 'pt', 'es']).default('en'),
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
// T4.4: records what the page IS (fields, actions, grids) WITHOUT what it holds: extracted[name] = DomStructure.
// Read-only; no value, typed text or cell text is read (see src/runner/extractStructure.ts).
const captureInventoryStep = z
  .object({ ...baseStep, action: z.literal('captureInventory'), name: safeName, includeHidden: z.boolean().default(true) })
  .strict();
// T7.6: presses Tab up to `maxTabs` times and records the focus order `[{ key, role, name, focusVisible }]` in extracted[name], with the controls
// that never got focus, a focus trap, and the stops whose focus is not visible (see src/runner/keyboardWalk.ts). Read-only apart from the Tab
// key itself and, with `startSelector`, one focus() call. It uses the built-in trusted scripts (T7.1), never caller code, so it does not need
// ALLOW_EVALUATE. It never fails on what it finds unless `failOn` lists the findings that must fail the step.
const keyboardWalkStep = z
  .object({
    ...baseStep,
    action: z.literal('keyboardWalk'),
    name: safeName,
    startSelector: selector.optional(),
    /** Limits the controls expected to be reached (default: the whole page; with startSelector and no scope, none is judged). */
    scope: selector.optional(),
    maxTabs: z.number().int().min(1).max(500).default(200),
    failOn: z.array(z.enum(['neverFocused', 'focusTrap', 'invisibleFocus'])).max(3).default([]),
    timeoutMs: stepTimeout,
  })
  .strict();
// T7.4/T7.5: runs axe-core (a built-in trusted script, T7.1: the caller sends no code, so ALLOW_EVALUATE does not apply) over the page, or over `scope`, and
// writes the normalized audit to extracted[name] (see src/a11y/audit.ts). It says which element breaks which rule, never what the element holds.
// `standard` picks the WCAG level (default wcag2aa). `failOn`: none (default, the step only records), any, serious (serious or critical) or new
// (a violation that the baseline does not have; needs `baseline`). `baseline` names a catalogue screen whose accessibility was captured by an evolution
// snapshot taken with `accessibility: true` (the latest one that has it, or `build`); the result then carries what is new and what was fixed since.
const auditAccessibilityStep = z
  .object({
    ...baseStep,
    action: z.literal('auditAccessibility'),
    name: safeName,
    scope: selector.optional(),
    standard: z.enum(ACCESSIBILITY_STANDARDS).default('wcag2aa'),
    /** Report only these axe rule ids (for example "color-contrast"). */
    rules: z.array(z.string().regex(/^[a-z0-9-]{1,80}$/)).min(1).max(100).optional(),
    failOn: z.enum(A11Y_FAIL_ON).default('none'),
    baseline: z
      .object({
        screen: z.string().regex(/^[a-zA-Z0-9_-]{1,52}$/),
        build: buildIdSchema.optional(),
        /** Default: the run's own targetProfile. */
        targetProfile: safeName.optional(),
      })
      .strict()
      .optional(),
    timeoutMs: stepTimeout,
  })
  .strict()
  .superRefine((step, ctx) => {
    if (step.failOn === 'new' && !step.baseline) {
      ctx.addIssue({ code: 'custom', path: ['baseline'], message: 'failOn "new" needs a baseline: there is no "new" without something to compare with' });
    }
  });
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
  assertEqualsStep,
  screenshotStep,
  collectStep,
  probePageStep,
  captureInventoryStep,
  keyboardWalkStep,
  auditAccessibilityStep,
  extractTextStep,
  extractAttributeStep,
  evaluateStep,
  watchStep,
  waitForElapsedStep,
  setViewportSizeStep,
]);

/**
 * T5.2: what `functional` stands in for. CSS is refused by name: Playwright decides visibility from computed style, so a run
 * without stylesheets would answer assertVisible/assertHidden wrongly.
 */
const stubbableTypes: readonly string[] = ['image', 'media', 'font'];
export const resourcePolicySchema = z
  .object({
    stub: z
      .array(
        z.string().superRefine((value, ctx) => {
          if (value === 'stylesheet') {
            ctx.addIssue({ code: 'custom', message: 'stylesheet can never be stubbed: element visibility in the browser depends on CSS' });
          } else if (!stubbableTypes.includes(value)) {
            ctx.addIssue({ code: 'custom', message: `cannot stub "${value}"; allowed: ${stubbableTypes.join(', ')}` });
          }
        }),
      )
      .max(3),
  })
  .strict();

/**
 * Resource types a run answers with a stand-in: an explicit `resourcePolicy.stub` wins (an empty list = none, even under
 * `functional`), otherwise `functional` stubs image, media and font and `full` stubs nothing.
 */
export function stubbedResourceTypes(options: { profile: 'full' | 'functional'; resourcePolicy?: { stub: string[] } }): string[] {
  if (options.resourcePolicy) return [...new Set(options.resourcePolicy.stub)];
  return options.profile === 'functional' ? [...stubbableTypes] : [];
}

// The object BEFORE superRefine. Derived schemas (e.g. the MCP one, without `credentials`) must be
// built from this, not from the refined schema, so no validation is lost or broken.
export const explorationOptionsSchema = z
  .object({
    headless: z.boolean().default(true),
    trace: z.boolean().default(false),
    screenshots: z.enum(['off', 'onFailure', 'always']).default('onFailure'),
    // T5.2: `functional` = stand-ins for images (1x1 PNG), media and fonts (204), and NO screenshots and NO trace, for fast
    // logic/rules runs. `full` (default) is what every run has always been. CSS is never stubbed.
    profile: z.enum(['full', 'functional']).default('full'),
    resourcePolicy: resourcePolicySchema.optional(),
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
    // T5.3: values the steps draw with `valueFromParameter`. `seed` makes them reproducible (absent: a fresh one is generated and
    // returned in result.parameters); `sample` is which value of each parameter this run takes (edge values first, then random).
    parameters: parametersSchema.optional(),
    seed: seedSchema.optional(),
    sample: sampleIndexSchema.optional(),
    // T5.6: the exact value of named parameters (replays a shrunk failure: "fails with qty=1000"). Wins over seed/sample for those names.
    parameterValues: parameterValuesSchema.optional(),
    caller: callerSchema.optional(),
    options: explorationOptionsSchema.default({ headless: true, trace: false, screenshots: 'onFailure', profile: 'full', collectDomOnFailure: false }),
    steps: z.array(explorationStepSchema).min(1).max(env.MAX_STEPS_PER_JOB),
    // T1.4: always runs after the steps, pass or fail (like `finally`). Failures here are recorded
    // apart and never replace the failure of the steps. Steps + teardown share MAX_STEPS_PER_JOB.
    teardown: z.array(explorationStepSchema).min(1).max(env.MAX_STEPS_PER_JOB).optional(),
  })
  .strict();

type RoutineForValidation = {
  targetUrl?: string;
  targetProfile?: string;
  parameters?: Array<{ name: string }>;
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
  validateParameterReferences(routine, ctx);

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

/**
 * A `valueFromParameter` must name a declared parameter. When the routine includes another one the name may be declared there, which
 * only the server can see (includes are expanded before the run), so the check is left to it; without includes it is made here.
 */
function validateParameterReferences(routine: RoutineForValidation, ctx: z.RefinementCtx): void {
  const lists = { steps: routine.steps, ...(routine.teardown ? { teardown: routine.teardown } : {}) };
  if (Object.values(lists).some((list) => list.some((step) => step.action === 'include'))) return;
  const declared = new Set((routine.parameters ?? []).map((parameter) => parameter.name));
  for (const [field, list] of Object.entries(lists)) {
    list.forEach((step, index) => {
      const name = (step as { valueFromParameter?: string }).valueFromParameter;
      if (name !== undefined && !declared.has(name)) {
        ctx.addIssue({ code: 'custom', path: [field, index, 'valueFromParameter'], message: `parameter "${name}" is not declared (declared: ${[...declared].join(', ') || 'none'})` });
      }
    });
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
