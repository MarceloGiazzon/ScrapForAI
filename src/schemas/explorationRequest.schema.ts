import { z } from 'zod';

import { env } from '../config/env.js';
import { MAX_EXPRESSION_CHARS, parseExpression } from '../oracle/expression.js';
import { A11Y_FAIL_ON, ACCESSIBILITY_STANDARDS } from './accessibility.schema.js';
import { docStepSchema } from './docStep.schema.js';
import { HTTP_MAX_REQUEST_BODY_CHARS, HTTP_METHODS, HTTP_SENSITIVE_RESPONSE_HEADERS } from './httpMethods.js';
import { placeholderNames, placeholderProblems } from './httpTemplate.js';
import { PII_SURFACES } from '../security/piiDetectors.js';
import { PII_FAIL_LEVELS } from '../security/piiFindings.js';
import { checkedGeneratorSchema, parameterName, parametersSchema, parameterValuesSchema, sampleIndexSchema, seedSchema, tableRefSchema } from './parameters.schema.js';
import { countSteps, extractedNamesOf, leafSteps, PARALLEL_ACTION, someStep, walkSteps, walkWithPath } from './stepTree.js';

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

/** T8.2: how long the page must have had no XHR/fetch pending. */
const quietSchema = z.object({ idleMs: z.number().int().min(50).max(10_000).optional() }).strict();

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
    // T8.2: no XHR/fetch pending for `idleMs` (default 300) in any frame; the wait is bounded by this condition's timeoutMs.
    quiet: quietSchema.optional(),
  })
  .strict()
  .superRefine((condition, ctx) => {
    const specifiedConditions = [condition.selector, condition.response, condition.loadState, condition.urlContains, condition.quiet].filter(
      (value) => value !== undefined,
    );

    if (specifiedConditions.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'wait condition must specify exactly one of: selector, response, loadState, urlContains, quiet',
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
  // T6.4: which actor (browser context) runs the step. Absent = `main`, the run's own session.
  actor: safeName.optional(),
  // T9.2: caption + highlight for the living manual. Inert unless the run sets options.docFigures; a step that has one must have an `id` (checked in validateStepList).
  doc: docStepSchema.optional(),
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
// T8.2: waits until no XHR/fetch is pending for idleMs (default 300), in every frame. The robust replacement for waitForTimeout and for networkidle.
const waitForQuietStep = z
  .object({ ...baseStep, action: z.literal('waitForQuiet'), idleMs: z.number().int().min(50).max(10_000).optional(), timeoutMs: stepTimeout })
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
    expected: z.union([
      z.object({ expr: expectedExpression }).strict(),
      z.object({ value: z.string().min(1).max(100) }).strict(),
      // T5.5: the cell of the run's row (its `sample`) in a stored table of cases, read with `locale`. The server turns it into `value` before the run.
      z.object({ table: tableRefSchema }).strict(),
    ]),
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
// T7.3: changes the clock the PAGE sees (Date, timers, requestAnimationFrame), through Playwright's page.clock. It does not touch the server's clock:
// a GeneXus date rule that runs on the server (most of them) sees the real date. The run records it in `result.clock` and the report says so.
//  - `fixedTime`: Date.now() / new Date() return that instant, always (timers keep running). Works before or after the page is open.
//  - `installAt`: the page's clock starts at that instant and then runs at normal speed; `fastForwardMs` then jumps it forward (due timers fire at most
//    once, like a person who left the tab asleep). Once per run: installing again would silently restart the time.
// Times are ISO 8601 WITH a zone ("2030-01-31T23:59:50-03:00" or "...Z"): the machine running the browser must not decide which day it is.
const MAX_CLOCK_YEAR = 2100;
const clockTime = z.iso
  .datetime({ offset: true })
  .refine((value) => {
    const year = new Date(value).getUTCFullYear();
    return year >= 1970 && year <= MAX_CLOCK_YEAR;
  }, { message: `the time must be between 1970 and ${MAX_CLOCK_YEAR}` });
const setClockStep = z
  .object({
    ...baseStep,
    action: z.literal('setClock'),
    fixedTime: clockTime.optional(),
    installAt: clockTime.optional(),
    /** Only with installAt. Up to ten years. */
    fastForwardMs: z.number().int().min(1).max(315_360_000_000).optional(),
  })
  .strict()
  .superRefine((step, ctx) => {
    if ((step.fixedTime === undefined) === (step.installAt === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'setClock needs exactly one of fixedTime or installAt' });
    }
    if (step.fastForwardMs !== undefined && step.installAt === undefined) {
      ctx.addIssue({ code: 'custom', path: ['fastForwardMs'], message: 'fastForwardMs only goes with installAt' });
    }
  });

// T7.2: from this step on, requests that match are answered wrongly on purpose, to see how the application copes: an HTTP error, a slow
// response, a dropped connection or a broken JSON body. Only requests to allowlisted origins are touched; each one is listed in
// result.evidence.routing with handledBy "fault". It ends after `times` matches, after the step `untilStep` finishes, or with the run.
// A target profile of environment "staging" must set flags.allowFaults. `malformedJson` answers 200 with a truncated JSON body, without
// calling the server (so nothing changes there); `delayMs` lets the REAL request through, late.
const faultSchema = z.union([
  z
    .object({
      status: z.number().int().min(100).max(599),
      body: z.string().max(10000).optional(),
      contentType: z.string().regex(/^[\w.+-]+\/[\w.+-]+(;\s*charset=[\w-]+)?$/).max(100).optional(),
    })
    .strict(),
  z.object({ delayMs: z.number().int().min(1).max(60000) }).strict(),
  z.object({ abort: z.enum(['failed', 'timedout']) }).strict(),
  z.object({ malformedJson: z.literal(true) }).strict(),
]);
const injectFaultStep = z
  .object({
    ...baseStep,
    action: z.literal('injectFault'),
    match: z
      .object({
        urlContains: z.string().min(1).max(500),
        method: z.string().regex(/^[A-Za-z]{3,10}$/).optional(),
      })
      .strict(),
    fault: faultSchema,
    times: z.number().int().min(1).max(1000).optional(),
    /** Id of a LATER step of the same list: the fault is removed when that step finishes (pass or fail). */
    untilStep: stepId.optional(),
  })
  .strict();

// T7.2: fails when the text of the page (or of `selector`) shows what a user must never see: a stack trace, an exception class, a database
// error, a server file path. The patterns are built in (src/runner/leakPatterns.ts): the caller sends no regular expression, which could
// stall the server on a long page. `contains` adds literal fragments. The error names the kinds found and a short, redacted example; it
// does not copy the page.
export const LEAK_KINDS = ['stackTrace', 'exception', 'sqlError', 'serverPath'] as const;
const assertNoTextMatchesStep = z
  .object({
    ...baseStep,
    action: z.literal('assertNoTextMatches'),
    selector: selector.optional(),
    kinds: z.array(z.enum(LEAK_KINDS)).min(1).max(LEAK_KINDS.length).optional(),
    contains: z.array(z.string().min(1).max(200)).min(1).max(20).optional(),
    timeoutMs: stepTimeout,
  })
  .strict();
// T7.8: looks for personal data and secrets where they should not be: in URLs (query and fragment), the console, storage, cookies without HttpOnly,
// hidden inputs and the body of requests that carried no credentials. Reads only: it changes no request. A finding holds a masked sample, a keyed
// fingerprint and a location, never the value. `failOn` is the severity at which the step fails (default: it only records); `extracted[name]` is the report.
const scanForPiiStep = z
  .object({
    ...baseStep,
    action: z.literal('scanForPii'),
    name: safeName,
    surfaces: z.array(z.enum(PII_SURFACES)).min(1).max(PII_SURFACES.length).optional(),
    failOn: z.enum(PII_FAIL_LEVELS).default('none'),
    timeoutMs: stepTimeout,
  })
  .strict();
// T5.7: one HTTP call made with the run's own session (the browser context's cookies), without a page: for server rules that need volume, not a UI.
// Same allowlist as a navigation (a path like "/api/x" resolves against the run's target URL); redirects are NOT followed (a 3xx is the answer); the
// profile decides which methods are allowed (default GET/HEAD); the caller sets no header but `contentType` (an Authorization header would be a secret
// in a routine), and the body is a literal (a vault value is refused at save, as everywhere). Nothing of the call reaches the page's network evidence:
// the answer is `extracted[name]` = { method, pathname, status, contentType, bytes } plus each `extract` entry (a JSON path or a response header).
// Fails when the status is not in `expectStatus` (default: any 2xx).
const httpExtractSchema = z
  .object({ name: safeName, json: z.string().min(1).max(500).optional(), header: z.string().regex(/^[A-Za-z0-9-]{1,100}$/).optional() })
  .strict()
  .refine((entry) => (entry.json === undefined) !== (entry.header === undefined), { message: 'an extract entry needs exactly one of json or header' })
  .refine((entry) => entry.header === undefined || !HTTP_SENSITIVE_RESPONSE_HEADERS.includes(entry.header.toLowerCase()), {
    message: 'that response header carries a session or credential and cannot be extracted',
  });
const httpRequestStep = z
  .object({
    ...baseStep,
    action: z.literal('httpRequest'),
    name: safeName,
    method: z.enum(HTTP_METHODS),
    url: z.string().min(1).max(2048),
    body: z.string().max(HTTP_MAX_REQUEST_BODY_CHARS).optional(),
    /** Default application/json when there is a body. */
    contentType: z.string().regex(/^[\w.+-]+\/[\w.+-]+(;\s*charset=[\w-]+)?$/).max(100).optional(),
    expectStatus: z.array(z.number().int().min(100).max(599)).min(1).max(20).optional(),
    extract: z.array(httpExtractSchema).min(1).max(20).optional(),
    timeoutMs: stepTimeout,
  })
  .strict()
  .superRefine((step, ctx) => {
    if (step.body !== undefined && (step.method === 'GET' || step.method === 'HEAD')) {
      ctx.addIssue({ code: 'custom', path: ['body'], message: `${step.method} carries no body` });
    }
    if (step.contentType !== undefined && step.body === undefined) {
      ctx.addIssue({ code: 'custom', path: ['contentType'], message: 'contentType only goes with a body' });
    }
    // `{{parameter}}` placeholders (httpTemplate.ts): the url takes the bare form only, since it percent-encodes every value.
    for (const problem of placeholderProblems(step.url, 'url')) ctx.addIssue({ code: 'custom', path: ['url'], message: problem });
    const seen = new Set<string>([step.name]);
    (step.extract ?? []).forEach((entry, index) => {
      if (seen.has(entry.name)) ctx.addIssue({ code: 'custom', path: ['extract', index, 'name'], message: `"${entry.name}" is already used by this step (its name or another extract entry)` });
      seen.add(entry.name);
    });
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
    // T6.4: the actor that runs the included steps that do not name one themselves (e.g. `include login` as `bob`).
    actor: safeName.optional(),
    routineId: safeName,
    version: z.number().int().positive().optional(),
  })
  .strict();

// T6.5 follow-up: a meeting point INSIDE the branches of a `parallel` block. A branch that reaches it waits until every branch of the block has, then they
// all go on together, which narrows the gap between the racing actions to the start-up of one step (milliseconds). Every branch of the block must hold the
// same barriers in the same order (a barrier waits for all of them, so one that only some branches reach would never be met), a name appears once per
// branch, and a barrier outside a block is refused: it would wait for nobody. Name the branch's actor on it, like on any other step of the branch.
// A branch that ends without reaching a barrier fails the others waiting there (BarrierBrokenError); `timeoutMs` (default STEP_TIMEOUT_MS) bounds the wait.
const barrierStep = z.object({ ...baseStep, action: z.literal('barrier'), name: safeName, timeoutMs: stepTimeout }).strict();

const leafStepOptions = [
  includeStep,
  barrierStep,
  gotoStep,
  reloadStep,
  setOfflineStep,
  waitForLoadStateStep,
  waitForQuietStep,
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
  injectFaultStep,
  assertNoTextMatchesStep,
  scanForPiiStep,
  setClockStep,
  httpRequestStep,
  extractTextStep,
  extractAttributeStep,
  evaluateStep,
  watchStep,
  waitForElapsedStep,
  setViewportSizeStep,
] as const;

const NESTED_PARALLEL_MESSAGE =
  'a parallel block cannot hold another one and is not allowed in a teardown: branches race against each other, each as its own actor, and the teardown cleans up one step after the other';

/** A nested `parallel` gets this message instead of zod's "Invalid input"; any other unknown action keeps zod's own. */
const stepActionError = (issue: { input?: unknown }): string | undefined =>
  (issue.input as { action?: unknown } | undefined)?.action === PARALLEL_ACTION ? NESTED_PARALLEL_MESSAGE : undefined;

/**
 * Every step except `parallel`: what a branch of a parallel block and a teardown may hold. Keeping `parallel` out of this union is what forbids
 * nesting, and it keeps the schema (and its JSON Schema) flat -- no recursion.
 */
export const leafStepSchema = z.discriminatedUnion('action', leafStepOptions, { error: stepActionError });

// T6.5: branches run at the same time (Promise.all), each as ONE actor and each actor in at most one branch, to provoke a real race: a double
// submit, two users saving the same record. Steps before the block are the setup (sequential, as always); the block holds only the racing part.
// Not a barrier: every branch starts as soon as the block does and goes at its own pace, so prepare everything first and race the last action.
const parallelStep = z
  .object({
    id: stepId.optional(),
    label: z.string().min(1).max(160).optional(),
    description: z.string().min(1).max(500).optional(),
    action: z.literal(PARALLEL_ACTION),
    branches: z.array(z.array(leafStepSchema).min(1)).min(2).max(env.MAX_ACTORS_PER_JOB),
  })
  .strict();

export const explorationStepSchema = z.discriminatedUnion('action', [parallelStep, ...leafStepOptions], { error: stepActionError });

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

const viewportSchema = z
  .object({
    width: z.number().int().min(50).max(4096),
    height: z.number().int().min(50).max(4096),
  })
  .strict();

/**
 * T6.4: an actor is one isolated browser context (own cookies, storage and page) inside the run's browser. `main` is the implicit actor of
 * every run: it uses the request's own `credentialSet` and `options.viewport`, so it can not be declared here. An actor with no `credentialSet`
 * has NO vault values (it never borrows main's), and may only type what a step spells out or a variable/parameter provides.
 */
export const MAIN_ACTOR = 'main';
export const actorSchema = z.object({ credentialSet: safeName.optional(), viewport: viewportSchema.optional() }).strict();
export const actorsSchema = z.record(safeName, actorSchema).superRefine((actors, ctx) => {
  if (Object.keys(actors).includes(MAIN_ACTOR)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [MAIN_ACTOR],
      message: `"${MAIN_ACTOR}" is the implicit actor of every run: set credentialSet and options.viewport on the request itself instead of declaring it`,
    });
  }
  if (Object.keys(actors).length > env.MAX_ACTORS_PER_JOB) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `at most ${env.MAX_ACTORS_PER_JOB} actors per run (MAX_ACTORS_PER_JOB)` });
  }
});
export type Actors = z.infer<typeof actorsSchema>;

// The object BEFORE superRefine. Derived schemas (e.g. the MCP one, without `credentials`) must be
// built from this, not from the refined schema, so no validation is lost or broken.
export const explorationOptionsSchema = z
  .object({
    headless: z.boolean().default(true),
    trace: z.boolean().default(false),
    screenshots: z
      .enum(['off', 'onFailure', 'always'])
      .describe(
        'Which images a run keeps. "off": none (screenshot steps are skipped too). "onFailure" (default) and "always" behave the same today: the images taken by ' +
          '`screenshot` steps, plus a "failure" image when a step fails. A run that passes and has no `screenshot` step has no image in any mode: add a ' +
          '{ "action": "screenshot", "name": "..." } step where you want one.',
      )
      .default('onFailure'),
    // T5.2: `functional` = stand-ins for images (1x1 PNG), media and fonts (204), and NO screenshots and NO trace, for fast
    // logic/rules runs. `full` (default) is what every run has always been. CSS is never stubbed.
    profile: z.enum(['full', 'functional']).default('full'),
    resourcePolicy: resourcePolicySchema.optional(),
    // T7.8: hunt for personal data and secrets during the whole run (URLs, console, bodies without credentials) and, at the end of the steps, in
    // storage, cookies and hidden inputs. The result carries `pii`. Optional with no default, so a saved routine keeps its digest.
    piiScan: z.boolean().optional(),
    // T6.3: also record the requests that SUCCEEDED (method, path, status, type; deduplicated, never a body or a query), in `evidence.traffic`. By default the
    // network evidence only holds failures. Differential runs ask for it; optional with no default, so a saved routine keeps its digest.
    recordTraffic: z.boolean().optional(),
    // T9.2: take the figures of the steps that carry `doc` (screenshot with the highlight drawn). `manual build` sets it; optional with no default, so a saved routine keeps its digest.
    docFigures: z.boolean().optional(),
    // T8.1: `false` turns off the automatic login of a `genexus` target profile for this run (its login routine is not included for you).
    autoLogin: z.boolean().optional(),
    collectDomOnFailure: z.boolean().default(false),
    viewport: viewportSchema.optional(),
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
    // T6.4: more sessions in one run (two users editing one record, a double submit, the second login that ends the first). Optional with no default,
    // so a saved routine keeps its digest and a run without actors is exactly what it always was.
    actors: actorsSchema.optional(),
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
    teardown: z.array(leafStepSchema).min(1).max(env.MAX_STEPS_PER_JOB).optional(),
  })
  .strict();

type RoutineForValidation = {
  targetUrl?: string;
  targetProfile?: string;
  options?: { docFigures?: boolean | undefined; screenshots?: string | undefined; profile?: string | undefined };
  parameters?: Array<{ name: string }>;
  actors?: Record<string, unknown>;
  steps: Array<z.infer<typeof explorationStepSchema>>;
  teardown?: Array<z.infer<typeof leafStepSchema>>;
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
  validateDocFigures(routine, ctx);
  validateParameterReferences(routine, ctx);
  validateActorReferences(routine, ctx);

  // A `parallel` block counts as one step plus the steps of its branches (each is a result of its own). Without a block this is the array length.
  const total = countSteps(routine.steps) + countSteps(routine.teardown ?? []);
  if (routine.teardown) {
    validateStepList(routine.teardown, 'teardown', ctx);

    if (total > env.MAX_STEPS_PER_JOB) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['teardown'],
        message: `steps + teardown exceed MAX_STEPS_PER_JOB (${env.MAX_STEPS_PER_JOB})`,
      });
    }
  } else if (total > env.MAX_STEPS_PER_JOB) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['steps'],
      message: `steps exceed MAX_STEPS_PER_JOB (${env.MAX_STEPS_PER_JOB}); a parallel block counts as one step plus the steps of its branches`,
    });
  }
}

/**
 * T9.2: a figure is only taken when the run asks (`options.docFigures`), and it needs screenshots: `functional` turns them off and stubs images, `screenshots: 'off'`
 * says no. Better to say so up front than to hand back a manual with holes.
 */
function validateDocFigures(routine: RoutineForValidation, ctx: z.RefinementCtx): void {
  if (routine.options?.docFigures !== true) return;
  if (routine.options.profile === 'functional') {
    ctx.addIssue({ code: 'custom', path: ['options', 'docFigures'], message: 'docFigures needs the full profile: the functional one replaces images with stand-ins and takes no screenshots' });
  }
  if (routine.options.screenshots === 'off') {
    ctx.addIssue({ code: 'custom', path: ['options', 'docFigures'], message: 'docFigures needs screenshots: options.screenshots is "off"' });
  }
}

/**
 * T9.2: the rules of a step that carries `doc`.
 *  - It needs an `id`: the figure is named after it, and the list of "figures that changed" must stay stable when steps are added before it.
 *  - Not in a teardown (cleanup is not documentation) and not in a `parallel` branch (what a race shows is not a figure).
 *  - Never AFTER a step that types a vault value: the figure would show what was typed. The default for those steps is before.
 */
function validateDocStep(step: AnyStep, path: Array<string | number>, field: 'steps' | 'teardown', ctx: z.RefinementCtx): void {
  const doc = (step as { doc: { when?: 'before' | 'after' } }).doc;
  if ((step as { id?: string }).id === undefined) {
    ctx.addIssue({ code: 'custom', path: [...path, 'doc'], message: 'a step with doc needs an id: the figure is named after it and the list of changed figures follows it' });
  }
  if (field === 'teardown') {
    ctx.addIssue({ code: 'custom', path: [...path, 'doc'], message: 'doc is not allowed in a teardown: cleanup is not part of the manual' });
  }
  if (path.includes('branches')) {
    ctx.addIssue({ code: 'custom', path: [...path, 'doc'], message: 'doc is not allowed inside a parallel branch: branches run at the same time, so a figure would show a moment chosen by the race' });
  }
  if (doc.when === 'after' && (step as { valueFromCredential?: string }).valueFromCredential !== undefined) {
    ctx.addIssue({ code: 'custom', path: [...path, 'doc', 'when'], message: 'a figure cannot be taken after a step that types a vault value (it would show it); use when: "before" or leave it out' });
  }
}

/**
 * A `valueFromParameter` must name a declared parameter. When the routine includes another one the name may be declared there, which
 * only the server can see (includes are expanded before the run), so the check is left to it; without includes it is made here.
 */
function validateParameterReferences(routine: RoutineForValidation, ctx: z.RefinementCtx): void {
  const lists = { steps: routine.steps, ...(routine.teardown ? { teardown: routine.teardown } : {}) };
  if (Object.values(lists).some((list) => someStep(list, (step) => step.action === 'include'))) return;
  const declared = new Set((routine.parameters ?? []).map((parameter) => parameter.name));
  for (const [field, list] of Object.entries(lists)) {
    for (const { step, path } of walkWithPath<object>(list, [field])) {
      const name = (step as { valueFromParameter?: string }).valueFromParameter;
      if (name !== undefined && !declared.has(name)) {
        ctx.addIssue({ code: 'custom', path: [...path, 'valueFromParameter'], message: `parameter "${name}" is not declared (declared: ${[...declared].join(', ') || 'none'})` });
      }
      // T5.7: an httpRequest names parameters inside its url and body as {{name}}.
      if ((step as { action?: string }).action === 'httpRequest') {
        const http = step as { url?: string; body?: string };
        for (const [field, text] of [['url', http.url], ['body', http.body]] as const) {
          for (const placeholder of placeholderNames(text)) {
            if (!declared.has(placeholder)) {
              ctx.addIssue({ code: 'custom', path: [...path, field], message: `{{${placeholder}}}: parameter "${placeholder}" is not declared (declared: ${[...declared].join(', ') || 'none'})` });
            }
          }
        }
      }
    }
  }
}

/**
 * T6.4: a step (or an include) may name only `main` or an actor the routine declares. Steps INSIDE an included routine are checked after the
 * include is expanded, with the includer's declarations: an included routine uses actor names its includer has to declare.
 */
function validateActorReferences(routine: RoutineForValidation, ctx: z.RefinementCtx): void {
  const declared = new Set([MAIN_ACTOR, ...Object.keys(routine.actors ?? {})]);
  const lists = { steps: routine.steps, ...(routine.teardown ? { teardown: routine.teardown } : {}) };
  for (const [field, list] of Object.entries(lists)) {
    for (const { step, path } of walkWithPath<object>(list, [field])) {
      const actor = (step as { actor?: string }).actor;
      if (actor !== undefined && !declared.has(actor)) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'actor'],
          message: `actor "${actor}" is not declared (declared: ${[...declared].join(', ')}); add it to "actors"`,
        });
      }
    }
  }
}

type AnyStep = z.infer<typeof explorationStepSchema>;

/**
 * Per-list checks: evaluate gating, forward references of waitForElapsed, duplicate ids -- and, inside a `parallel` block (T6.5), the rules that
 * keep a race a race and not a mess.
 *
 * Ids are unique across the WHOLE list, branches included (`untilStep`, `waitForElapsed` and the step finish times are keyed by id). What a step
 * may refer to as "earlier" is what finished before it: the steps before its block and the ones before it in its own branch, never a sibling
 * branch's (they run at the same time, so their order is a coin toss). After the block, every branch's steps are earlier.
 */
function validateStepList(steps: readonly AnyStep[], field: 'steps' | 'teardown', ctx: z.RefinementCtx): void {
  const seen = new Set<string>();

  const visit = (list: readonly AnyStep[], path: Array<string | number>, visible: Set<string>, inBranch = false): void => {
    list.forEach((step, index) => {
      const here = [...path, index];

      if (step.action === 'barrier' && !inBranch) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...here, 'action'],
          message: 'a barrier only works inside a parallel branch: it makes the branches wait for each other, so outside a block (or in a teardown) it would wait for nobody',
        });
      }

      if (!env.ALLOW_EVALUATE && (step.action === 'evaluate' || step.action === 'watch')) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...here, 'action'], message: 'evaluate/watch are disabled (set ALLOW_EVALUATE=true)' });
      }

      if (step.action === 'waitForElapsed' && !visible.has(step.sinceStepId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...here, 'sinceStepId'],
          message: `sinceStepId "${step.sinceStepId}" must match the id of an earlier step (inside a parallel branch: before the block, or earlier in the same branch)`,
        });
      }

      if (step.action === 'injectFault' && step.untilStep !== undefined) {
        // The fault is on while the steps up to `untilStep` run, so that step must come AFTER the fault in the same list (a later block's steps count).
        const laterIds = new Set([...walkSteps(list.slice(index + 1))].map((later) => (later as { id?: string }).id));
        if (!laterIds.has(step.untilStep)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...here, 'untilStep'],
            message: `untilStep "${step.untilStep}" must match the id of a LATER step of the same list (the fault ends when that step finishes)`,
          });
        }
      }

      if ((step as { doc?: unknown }).doc !== undefined) validateDocStep(step, here, field, ctx);

      if (step.id) {
        if (seen.has(step.id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...here, 'id'], message: `duplicate step id "${step.id}"` });
        }
        seen.add(step.id);
      }

      if (step.action === 'parallel') {
        validateParallelBlock(step, here, ctx);
        const finished: string[] = [];
        step.branches.forEach((branch, b) => {
          // Each branch starts from what was visible at the block, and sees its own earlier steps as it goes.
          const own = new Set(visible);
          visit(branch as readonly AnyStep[], [...here, 'branches', b], own, true);
          for (const id of own) if (!visible.has(id)) finished.push(id);
        });
        for (const id of finished) visible.add(id);
      }
      if (step.id) visible.add(step.id);
    });
  };

  visit(steps, [field], new Set());
}

/**
 * The rules of one `parallel` block that need only the block itself. A branch is ONE actor's flow and an actor is in at most one branch: two
 * flows racing on the same page would be a mess, not a race. An `include` that names no actor says nothing about its steps' actors until it is
 * expanded, so that branch is judged then (the expanded request goes through this same check).
 */
function validateParallelBlock(step: Extract<AnyStep, { action: 'parallel' }>, path: Array<string | number>, ctx: z.RefinementCtx): void {
  const actorOfBranch = new Map<number, string>();

  step.branches.forEach((branch, b) => {
    const actors = new Set<string>();
    let unknown = false;
    for (const leaf of leafSteps(branch as readonly object[])) {
      const named = (leaf as { actor?: string; action?: string }).actor;
      if ((leaf as { action?: string }).action === 'include' && named === undefined) unknown = true;
      else actors.add(named ?? MAIN_ACTOR);
    }
    if (actors.size > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, 'branches', b],
        message: `a parallel branch runs as ONE actor but this one uses ${[...actors].join(', ')}; give each actor its own branch`,
      });
    } else if (actors.size === 1 && !unknown) {
      actorOfBranch.set(b, [...actors][0]!);
    }
  });

  const firstBranchOf = new Map<string, number>();
  for (const [b, actor] of actorOfBranch) {
    const first = firstBranchOf.get(actor);
    if (first !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, 'branches', b],
        message: `branches ${first} and ${b} both run as actor "${actor}": one session cannot race against itself; give each branch its own actor`,
      });
    } else {
      firstBranchOf.set(actor, b);
    }
  }

  validateBarriers(step, path, ctx);

  // Two branches writing the same `extracted` name would leave the value to the race.
  const writer = new Map<string, number>();
  step.branches.forEach((branch, b) => {
    for (const leaf of leafSteps(branch as readonly object[])) {
      for (const name of extractedNamesOf(leaf)) {
        const other = writer.get(name);
        if (other !== undefined && other !== b) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, 'branches', b],
            message: `branches ${other} and ${b} both extract "${name}": the value would depend on which branch finishes last; use a different name in each`,
          });
        } else {
          writer.set(name, b);
        }
      }
    }
  });
}

/**
 * The barriers of one block. A barrier waits for EVERY branch, so every branch must hold the same ones in the same order (otherwise one would wait for a
 * branch that never comes, or two branches would wait for each other at different barriers), and a name is a meeting point: once per branch. A branch
 * that holds an `include` is judged after the include is expanded (its steps are not known yet), when the expanded request goes through this check again.
 */
function validateBarriers(step: Extract<AnyStep, { action: 'parallel' }>, path: Array<string | number>, ctx: z.RefinementCtx): void {
  const branches = step.branches.map((branch) => [...leafSteps(branch as readonly object[])] as Array<{ action?: string; name?: string }>);
  if (branches.some((leaves) => leaves.some((leaf) => leaf.action === 'include'))) return;

  const names = branches.map((leaves) => leaves.filter((leaf) => leaf.action === 'barrier').map((leaf) => leaf.name ?? ''));
  names.forEach((own, b) => {
    const repeated = own.find((name, index) => own.indexOf(name) !== index);
    if (repeated !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, 'branches', b],
        message: `barrier "${repeated}" appears twice in branch ${b}: a name is one meeting point, so the second one needs another name`,
      });
    }
  });

  const reference = names[0]!;
  names.forEach((own, b) => {
    if (b > 0 && own.join('\u0000') !== reference.join('\u0000')) {
      const list = (items: string[]) => (items.length === 0 ? 'none' : items.map((name) => `"${name}"`).join(', '));
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, 'branches', b],
        message: `branch ${b} holds the barriers ${list(own)} but branch 0 holds ${list(reference)}: every branch must reach the same barriers in the same order, because a barrier waits for all of them`,
      });
    }
  });
}

export const explorationRequestSchema = explorationRequestBaseSchema.superRefine(validateRoutine);

// What the MCP tool accepts: the same request minus inline `credentials`, so a model cannot
// supply secret values. (.strict() makes a stray `credentials` key a validation error.)
export const mcpExplorationRequestSchema = explorationRequestBaseSchema.omit({ credentials: true }).superRefine(validateRoutine);

export type ExplorationRequest = z.infer<typeof explorationRequestSchema>;
export type ExplorationStep = z.infer<typeof explorationStepSchema>;
/** Every step but `parallel`: what a branch and a teardown hold (T6.5). */
export type LeafStep = z.infer<typeof leafStepSchema>;
export type ParallelStep = z.infer<typeof parallelStep>;
/** A step that acts on a page and can be executed: includes have already been expanded away (T1.4). */
export type RunnableLeaf = Exclude<LeafStep, { action: 'include' }>;
/** A `parallel` block once its branches are expanded (T6.5). */
export type RunnableParallel = Omit<ParallelStep, 'branches'> & { branches: RunnableLeaf[][] };
/** A step the runner can execute: includes have already been expanded away (T1.4). */
export type RunnableStep = RunnableLeaf | RunnableParallel;
export type ValueSource = z.infer<typeof valueSource>;
export type Caller = z.infer<typeof callerSchema>;
export type FrameRef = z.infer<typeof frameRefSchema>;
export type WaitCondition = z.infer<typeof waitConditionSchema>;
