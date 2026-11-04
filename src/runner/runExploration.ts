import { setTimeout as sleep } from 'node:timers/promises';

import { nanoid } from 'nanoid';
import type { Browser, Frame, Page } from 'playwright';

import { compareAudits, failureFor, normalizeAxeAnswer, type RawAxeAnswer } from '../a11y/audit.js';
import { createArtifactStore, saveJsonFile } from '../artifacts/artifactStore.js';
import { env } from '../config/env.js';
import { buildManifest, writeManifest } from '../evidence/manifest.js';
import { loadAccessibilityBaseline } from '../evolution/evolutionService.js';
import { appendRun } from '../history/runHistoryStore.js';
import { summarizeResult } from '../history/summarizeResult.js';
import { checkAssertEquals } from '../oracle/assertEquals.js';
import { type AccessibilityDelta, STANDARD_TAGS } from '../schemas/accessibility.schema.js';
import { type FrameRef, type RunnableStep, stubbedResourceTypes, type WaitCondition } from '../schemas/explorationRequest.schema.js';
import type { ClockEvidence, EvidenceBlock, ExplorationResult, JsonValue, StepResult } from '../schemas/explorationResult.schema.js';
import type { PiiReport } from '../schemas/pii.schema.js';
import { assertCredentialOrigin, type CredentialBinding } from '../security/credentialBinding.js';
import { maskText, maskUrl, PII_SURFACES } from '../security/piiDetectors.js';
import { meetsFailLevel, SEVERITY_RANK } from '../security/piiFindings.js';
import { getPiiFingerprintKey } from '../security/piiSalt.js';
import { collectKnownSecretValues, redactSecrets, redactString } from '../security/redactSecrets.js';
import { validateTargetUrl } from '../security/validateTargetUrl.js';
import { applyNoiseFilters, noiseRulesFor } from '../targets/platformRules.js';
import { getTarget } from '../targets/targetStore.js';
import { probeBuildId, UNKNOWN_BUILD } from './buildProbe.js';
import { type EvidenceCollector, registerEvidenceCollectors } from './collectEvidence.js';
import { extractStructure } from './extractStructure.js';
import { createFaultController, type FaultController, usesFaults } from './faults.js';
import { type ActiveElement, type Candidate, type StyleSignature, walkKeyboard } from './keyboardWalk.js';
import { ALL_LEAK_KINDS, findLeaks } from './leakPatterns.js';
import { usesQuiet, waitForNetworkQuiet } from './networkQuiet.js';
import { PiiScanner, usesPiiScan } from './piiScanner.js';
import { runTrustedScript } from './trusted/runTrusted.js';
import type { ResolvedExplorationRequest } from './resolveRequest.js';
import { actorOf, actorsInUse, isMultiActor, MAIN_ACTOR } from './actors.js';
import { mergeEvidence, mergePiiReports } from './mergeEvidence.js';
import { type ActorContext, launchBrowser, openActorContext } from './playwrightContext.js';

/**
 * T6.4: everything that belongs to ONE actor -- its isolated browser context and page, the evidence it collected, its own fault controller
 * and PII hunt, and the vault values only it may type. A run has one per actor that runs a step; a run without actors has just `main`.
 */
interface ActorSession {
  name: string;
  ctx: ActorContext;
  evidence: EvidenceCollector;
  faults: FaultController | undefined;
  pii: PiiScanner | undefined;
  /** `setClock` installAt is allowed once per browser context. */
  clockInstalled: boolean;
  credentials: Record<string, string> | undefined;
  binding: CredentialBinding | undefined;
  credentialSet: string | undefined;
  domTextSnapshot: string | undefined;
  stepsRun: number;
  tracePath: string | undefined;
  finalUrl: string | undefined;
}

class StepExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StepExecutionError';
  }
}

function timeoutFor(step: RunnableStep): number {
  const timeoutMs = 'timeoutMs' in step ? step.timeoutMs : undefined;
  return Math.min(timeoutMs ?? env.STEP_TIMEOUT_MS, env.STEP_TIMEOUT_MS);
}

function waitConditionTimeout(condition: WaitCondition): number {
  return condition.timeoutMs ?? env.STEP_TIMEOUT_MS;
}

export function resolveFrame(page: Page, ref?: FrameRef): Frame {
  if (!ref) {
    return page.mainFrame();
  }

  if ('name' in ref) {
    return page.frame({ name: ref.name }) ?? page.mainFrame();
  }

  if ('urlContains' in ref) {
    return page.frames().find((frame) => frame.url().includes(ref.urlContains)) ?? page.mainFrame();
  }

  return page.frames()[ref.index] ?? page.mainFrame();
}

export async function applyWaitCondition(page: Page, frameRef: FrameRef | undefined, condition: WaitCondition): Promise<void> {
  const frame = resolveFrame(page, frameRef);
  const timeout = waitConditionTimeout(condition);

  if (condition.selector) {
    await frame.locator(condition.selector).waitFor({ state: condition.state ?? 'visible', timeout });
    return;
  }

  if (condition.loadState) {
    await frame.waitForLoadState(condition.loadState, { timeout });
    return;
  }

  if (condition.quiet) {
    await waitForNetworkQuiet(page, { ...(condition.quiet.idleMs === undefined ? {} : { idleMs: condition.quiet.idleMs }), timeoutMs: timeout });
    return;
  }

  if (condition.urlContains) {
    await page.waitForURL((url) => url.toString().includes(condition.urlContains!), { timeout });
    return;
  }

  if (condition.response) {
    await waitForResponseCondition(page, condition);
  }
}

export function waitForResponseCondition(page: Page, condition: WaitCondition): Promise<unknown> {
  if (!condition.response) {
    return Promise.resolve();
  }

  return page.waitForResponse(
    (response) =>
      response.url().includes(condition.response!.urlContains) &&
      (condition.response!.status === undefined || response.status() === condition.response!.status),
    { timeout: waitConditionTimeout(condition) },
  );
}

export function buildEvaluateExpression(script: string): string {
  return `(() => { ${script} })()`;
}

function normalizeJsonValue(value: unknown, seen = new WeakSet<object>()): JsonValue {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return null;
  }

  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonValue(item, seen));
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }

    seen.add(value);
    const normalized: { [key: string]: JsonValue } = {};

    for (const [key, item] of Object.entries(value)) {
      normalized[key] = normalizeJsonValue(item, seen);
    }

    seen.delete(value);
    return normalized;
  }

  return null;
}

export function capAndRedactEvaluateResult(value: unknown, knownSecrets: string[] = []): JsonValue {
  const redacted = redactSecrets(normalizeJsonValue(value), knownSecrets);
  const json = JSON.stringify(redacted);

  if (json.length > env.MAX_EVALUATE_RESULT_CHARS) {
    return {
      truncated: true,
      preview: json.slice(0, env.MAX_EVALUATE_RESULT_CHARS),
    };
  }

  return redacted;
}

export async function runEvaluate(frame: Frame, script: string): Promise<unknown> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new StepExecutionError('evaluate timeout')), env.EVALUATE_TIMEOUT_MS);
  });

  try {
    return await Promise.race([frame.evaluate(buildEvaluateExpression(script)), timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function resolveValue(step: RunnableStep, request: ResolvedExplorationRequest, targetFrame: Frame, actor: ActorSession): string {
  if ('value' in step && step.value !== undefined) {
    return step.value;
  }

  if ('valueFromCredential' in step && step.valueFromCredential !== undefined) {
    const value = actor.credentials?.[step.valueFromCredential];
    if (value === undefined) {
      throw new StepExecutionError(
        actor.name === MAIN_ACTOR
          ? 'Credential value was not provided'
          : `Credential value was not provided for actor "${actor.name}" (it has no credentialSet, or its set has no such field)`,
      );
    }
    // Vault-sourced values may only be typed into pages of their bound origins (T1.2): the origins of THIS actor's set (T6.4).
    assertCredentialOrigin(actor.binding, step.valueFromCredential, targetFrame.url());
    return value;
  }

  if ('valueFromParameter' in step && step.valueFromParameter !== undefined) {
    const value = request.parameterRecord?.values[step.valueFromParameter];
    if (value === undefined) {
      throw new StepExecutionError('Parameter value was not generated');
    }
    return value;
  }

  if ('valueFromVariable' in step && step.valueFromVariable !== undefined) {
    const value = request.variables?.[step.valueFromVariable];
    if (value === undefined) {
      throw new StepExecutionError('Variable value was not provided');
    }
    return value;
  }

  throw new StepExecutionError('Step value source was not provided');
}

function compareCount(actual: number, operator: string, expected: number): boolean {
  switch (operator) {
    case '=':
      return actual === expected;
    case '!=':
      return actual !== expected;
    case '>':
      return actual > expected;
    case '>=':
      return actual >= expected;
    case '<':
      return actual < expected;
    case '<=':
      return actual <= expected;
    default:
      return false;
  }
}

async function waitForUrlContains(getUrl: () => string, value: string, timeoutMs: number): Promise<void> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (getUrl().includes(value)) {
      return;
    }
    await sleep(100);
  }

  throw new StepExecutionError('Timeout waiting for URL condition');
}

async function withJobTimeout<T>(promise: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new StepExecutionError('Job timed out')), env.JOB_TIMEOUT_MS);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function runExploration(request: ResolvedExplorationRequest): Promise<ExplorationResult> {
  return withJobTimeout(runExplorationInner(request));
}

async function runExplorationInner(request: ResolvedExplorationRequest): Promise<ExplorationResult> {
  // T6.4: the values of every actor's vault set are secrets of the run (blanked from every output, found by the PII hunt).
  const knownSecrets = collectKnownSecretValues(
    request.credentials,
    { SCRAPFORAI_API_KEY: env.SCRAPFORAI_API_KEY },
    ...Object.values(request.actorCredentials ?? {}).map((actor) => actor.credentials),
  );
  const usedActors = actorsInUse(request);
  const multiActor = isMultiActor(usedActors);
  const jobId = `job_${nanoid(12)}`;
  const startedAt = new Date();
  const normalizedTargetUrl = validateTargetUrl(request.targetUrl);
  const artifactStore = await createArtifactStore(jobId);
  // T5.2: a functional run keeps no screenshots and no trace, whatever the options say.
  const functional = request.options.profile === 'functional';
  const screenshotMode = functional ? 'off' : request.options.screenshots;
  const traceOn = functional ? false : request.options.trace;
  // T6.4: one browser, one isolated context per actor that runs a step (in the order of their first step). A run without actors has just `main`.
  let browser: Browser | undefined;
  const sessions = new Map<string, ActorSession>();
  const extracted: Record<string, JsonValue> = {};
  const steps: StepResult[] = [];
  const teardownSteps: StepResult[] = [];
  const stepFinishedAt = new Map<string, number>();
  let failedStepIndex: number | undefined;
  let resultError: ExplorationResult['error'];
  let tracePath: string | undefined;
  let domTextSnapshot: string | undefined;
  let finalUrl: string | undefined;
  let probedBuildId: string | undefined;
  // T7.3: what setClock did to the browser's clock.
  const clockEvents: ClockEvidence[] = [];
  // T7.8: the PII hunt of this run, only for a run that asks for it (options.piiScan or a scanForPii step).
  let hunting = false;
  let piiReport: ExplorationResult['pii'];
  // T8.1: the target profile of the run, when it has one (platform rules and noise filters).
  let profile: Awaited<ReturnType<typeof getTarget>> | undefined;

  try {
    // FORCE_HEADLESS (set by the Light distribution, which bundles only the headless shell)
    // overrides a headed request so it degrades to headless instead of failing to launch a
    // browser that was never bundled.
    const headless = env.FORCE_HEADLESS || request.options.headless;
    // The profile is read once: its platform and noise filters (T8.1) and its PII policy (T7.9) are used below.
    profile = request.targetProfile ? await getTarget(request.targetProfile).catch(() => undefined) : undefined;

    browser = await launchBrowser(headless);
    const piiKey = usesPiiScan(request) ? await getPiiFingerprintKey() : undefined;
    const piiPolicy = profile?.pii;
    for (const name of usedActors) {
      // T7.2: the fault policy is installed only for a run that has an injectFault step; any other run installs nothing for it.
      // One controller per actor: a fault hits the actor it was injected for, not every session of the run.
      const faults: FaultController | undefined = usesFaults(request) ? createFaultController() : undefined;
      const declared = name === MAIN_ACTOR ? undefined : request.actors?.[name];
      const ctx = await openActorContext(browser, name === MAIN_ACTOR ? request.options.viewport : (declared?.viewport ?? request.options.viewport), {
        stubResources: stubbedResourceTypes(request.options),
        ...(faults ? { faults: faults.policy } : {}),
        ...(usesQuiet(request) ? { networkTracker: true } : {}),
      });
      const own = name === MAIN_ACTOR ? undefined : request.actorCredentials?.[name];
      const session: ActorSession = {
        name,
        ctx,
        // A screenshot of another actor goes to its own file (`bob--home.png`): two actors may both take "home".
        evidence: registerEvidenceCollectors(ctx.page, artifactStore, ctx.routing.isHandled, request.options.recordTraffic === true, name === MAIN_ACTOR ? '' : `${name}--`),
        faults,
        pii: undefined,
        clockInstalled: false,
        // An actor never borrows main's vault values, and main never gets an actor's.
        credentials: name === MAIN_ACTOR ? request.credentials : own?.credentials,
        binding: name === MAIN_ACTOR ? request.credentialBinding : own?.credentialBinding,
        credentialSet: name === MAIN_ACTOR ? request.credentialSet : declared?.credentialSet,
        domTextSnapshot: undefined,
        stepsRun: 0,
        tracePath: undefined,
        finalUrl: undefined,
      };
      sessions.set(name, session);

      if (piiKey !== undefined) {
        // T7.9: what this application's profile says is expected, and how serious each kind of finding is here.
        session.pii = new PiiScanner(ctx.page, ctx.context, {
          // The vault values of this run, plus the API key: any of them showing up on a page is a leak.
          knownSecrets,
          key: piiKey,
          ...(piiPolicy ? { policy: piiPolicy } : {}),
        });
        session.pii.attach();
        hunting = true;
      }

      if (traceOn) {
        await ctx.context.tracing.start({ screenshots: false, snapshots: true, sources: false });
      }
    }
    const primary = sessions.get(usedActors[0]!)!;

    // One step, in either phase. Teardown (T1.4) uses the same machinery but must not touch the verdict:
    // its failures stay in teardownSteps and never set failedStepIndex/resultError.
    const runStep = async (step: RunnableStep, index: number, phase: 'steps' | 'teardown'): Promise<boolean> => {
      // Every actor a step names was opened above (actorsInUse reads the same lists).
      const session = sessions.get(actorOf(step))!;
      const evidence = session.evidence;
      let stepFailed = false;
      const stepStartedAt = new Date();
      let responseWaiter: Promise<unknown> | undefined;
      const stepResult: StepResult = {
        index,
        id: step.id,
        label: step.label,
        description: step.description,
        ...(step.actor === undefined ? {} : { actor: step.actor }),
        action: step.action,
        status: 'passed',
        startedAt: stepStartedAt.toISOString(),
        finishedAt: stepStartedAt.toISOString(),
        durationMs: 0,
      };

      try {
        const page = session.ctx.page;
        const timeout = timeoutFor(step);
        const frame = resolveFrame(page, step.frame);

        if (step.delayMs !== undefined) {
          await page.waitForTimeout(step.delayMs);
        }

        if (step.waitFor) {
          await applyWaitCondition(page, step.frame, step.waitFor);
        }

        if (step.afterWaitFor?.response) {
          responseWaiter = waitForResponseCondition(page, step.afterWaitFor);
        }

        switch (step.action) {
          case 'goto': {
            const url = step.url === '$targetUrl' ? normalizedTargetUrl : validateTargetUrl(step.url);
            const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
            if (response) {
              validateTargetUrl(response.url());
            }
            validateTargetUrl(page.url());
            break;
          }
          case 'reload': {
            const response = await page.reload({ waitUntil: 'domcontentloaded', timeout });
            if (response) {
              validateTargetUrl(response.url());
            }
            validateTargetUrl(page.url());
            break;
          }
          case 'setOffline':
            // Cuts (or restores) the network for the whole browser context: fetch/XHR fail, navigator.onLine
            // flips and the page gets its online/offline events, exactly as a real connection drop does.
            await session.ctx.context.setOffline(step.offline);
            break;
          case 'waitForLoadState':
            await frame.waitForLoadState(step.state, { timeout });
            break;
          case 'waitForQuiet':
            await waitForNetworkQuiet(page, { ...(step.idleMs === undefined ? {} : { idleMs: step.idleMs }), timeoutMs: timeout });
            break;
          case 'waitForUrlContains':
            await waitForUrlContains(() => page.url(), step.value, timeout);
            break;
          case 'waitForTimeout':
            await page.waitForTimeout(timeout);
            break;
          case 'setViewport':
            await page.setViewportSize({ width: step.width, height: step.height });
            break;
          case 'resizeWindow': {
            // Resize the real browser window via CDP (Browser.setWindowBounds) so
            // framework layout engines (e.g. ExtJS onWindowResize) recalculate exactly
            // as a physical window drag does. Also calls setViewportSize so Playwright's
            // viewport emulation stays in sync for correct screenshots. Chromium only.
            const cdp = await browser!.newBrowserCDPSession();
            try {
              // T6.4: the window of THIS actor's page. "The first page of the browser" is wrong once several actors share the browser.
              let targetId: string | undefined;
              const pageCdp = await session.ctx.context.newCDPSession(page).catch(() => undefined);
              try {
                targetId = pageCdp ? ((await pageCdp.send('Target.getTargetInfo')) as { targetInfo: { targetId: string } }).targetInfo.targetId : undefined;
              } catch {
                targetId = undefined;
              } finally {
                await pageCdp?.detach().catch(() => undefined);
              }
              if (targetId === undefined) {
                const { targetInfos } = await cdp.send('Target.getTargets', {}) as { targetInfos: Array<{ targetId: string; type: string }> };
                targetId = targetInfos.find((t) => t.type === 'page')?.targetId;
              }
              if (targetId === undefined) {
                throw new StepExecutionError('resizeWindow: no page target found via CDP');
              }
              const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId }) as { windowId: number };
              await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: step.width, height: step.height } });
            } finally {
              await cdp.detach().catch(() => undefined);
            }
            await page.setViewportSize({ width: step.width, height: step.height });
            break;
          }
          case 'fill':
            await frame.locator(step.selector).fill(resolveValue(step, request, frame, session), { timeout });
            break;
          case 'click':
            await frame.locator(step.selector).click({ timeout });
            break;
          case 'doubleClick':
            await frame.locator(step.selector).dblclick({ timeout });
            break;
          case 'hover':
            await frame.locator(step.selector).hover({ timeout });
            break;
          case 'press':
            await frame.locator(step.selector).press(step.key, { timeout });
            break;
          case 'selectOption':
            await frame.locator(step.selector).selectOption(resolveValue(step, request, frame, session), { timeout });
            break;
          case 'check':
            await frame.locator(step.selector).check({ timeout });
            break;
          case 'uncheck':
            await frame.locator(step.selector).uncheck({ timeout });
            break;
          case 'waitForSelector':
            await frame.locator(step.selector).waitFor({ state: step.state, timeout });
            break;
          case 'setViewportSize':
            await page.setViewportSize({ width: step.width, height: step.height });
            break;
          case 'waitForResponse':
            await page.waitForResponse(
              (response) => {
                const methodMatches = step.method ? response.request().method().toUpperCase() === step.method.toUpperCase() : true;
                const statusMatches = step.status ? response.status() === step.status : true;
                return response.url().includes(step.urlContains) && methodMatches && statusMatches;
              },
              { timeout },
            );
            break;
          case 'assertVisible':
            if (!(await frame.locator(step.selector).isVisible({ timeout }))) {
              throw new StepExecutionError('Expected selector to be visible');
            }
            break;
          case 'assertHidden':
            if (!(await frame.locator(step.selector).isHidden({ timeout }))) {
              throw new StepExecutionError('Expected selector to be hidden');
            }
            break;
          case 'assertEnabled':
            if (!(await frame.locator(step.selector).isEnabled({ timeout }))) {
              throw new StepExecutionError('Expected selector to be enabled');
            }
            break;
          case 'assertDisabled':
            if (!(await frame.locator(step.selector).isDisabled({ timeout }))) {
              throw new StepExecutionError('Expected selector to be disabled');
            }
            break;
          case 'assertTextContains': {
            const text = await frame.locator(step.selector).innerText({ timeout });
            if (!text.includes(step.text)) {
              throw new StepExecutionError('Expected selector text to contain requested text');
            }
            break;
          }
          case 'assertUrlContains':
            if (!page.url().includes(step.value)) {
              throw new StepExecutionError('Expected URL to contain requested value');
            }
            break;
          case 'assertCount': {
            const count = await frame.locator(step.selector).count();
            if (!compareCount(count, step.operator, step.count)) {
              throw new StepExecutionError('Expected selector count condition was not met');
            }
            break;
          }
          case 'assertEquals': {
            // T5.5: a formula over the run's parameters and extracted values (src/oracle). Pure; no page access.
            let outcome: ReturnType<typeof checkAssertEquals>;
            try {
              outcome = checkAssertEquals({
                actual: step.actual,
                expected: step.expected,
                ...(step.tolerance ? { tolerance: step.tolerance } : {}),
                locale: step.locale,
                parameters: request.parameterRecord?.values ?? {},
                extracted,
              });
            } catch (error) {
              throw new StepExecutionError(`assertEquals: ${error instanceof Error ? error.message : 'could not be evaluated'}`);
            }
            if (!outcome.passed) {
              throw new StepExecutionError(`assertEquals: ${outcome.message}`);
            }
            break;
          }
          case 'screenshot':
            if (screenshotMode !== 'off') {
              await evidence.captureScreenshot(step.name);
            }
            break;
          case 'collect':
            if (step.what.includes('domText')) {
              const domText = await evidence.collectDomText();
              if (domText) {
                domTextSnapshot = domText;
                session.domTextSnapshot = domText;
              }
            }

            if (step.what.includes('url')) {
              finalUrl = page.url();
            }
            break;
          case 'probePage': {
            // Never fails on what it finds: a missing control or a denial page is the answer (T6.1).
            let selectorState: { count: number; visible: boolean; enabled: boolean } | undefined;
            if (step.selector !== undefined) {
              const locator = frame.locator(step.selector);
              if (step.timeoutMs !== undefined) {
                await locator.first().waitFor({ state: 'attached', timeout }).catch(() => undefined);
              }
              const count = await locator.count();
              const visible = count > 0 && (await locator.first().isVisible().catch(() => false));
              const enabled = count > 0 && (await locator.first().isEnabled({ timeout: 1000 }).catch(() => false));
              selectorState = { count, visible, enabled };
            }

            const markers = step.textMarkers ?? [];
            const bodyText = markers.length > 0 ? await frame.locator('body').innerText({ timeout: 2000 }).catch(() => '') : '';
            // A fixed, built-in read of the browser's navigation timing, not a caller script: allowed without ALLOW_EVALUATE.
            const documentStatus = await frame
              .evaluate(() => {
                const entry = performance.getEntriesByType('navigation')[0] as (PerformanceEntry & { responseStatus?: number }) | undefined;
                return typeof entry?.responseStatus === 'number' && entry.responseStatus > 0 ? entry.responseStatus : null;
              })
              .catch(() => null);

            extracted[step.name] = {
              url: frame.url(),
              documentStatus,
              markersFound: markers.filter((marker) => bodyText.includes(marker)),
              ...(selectorState ? { selector: selectorState } : {}),
            };
            break;
          }
          case 'captureInventory':
            extracted[step.name] = (await extractStructure(frame, { includeHiddenControls: step.includeHidden })) as unknown as JsonValue;
            break;
          case 'keyboardWalk': {
            // T7.6, with the built-in trusted scripts (T7.1): the caller names no code, so ALLOW_EVALUATE does not apply.
            const secrets = { knownSecrets };
            if (step.startSelector !== undefined) await frame.locator(step.startSelector).first().focus({ timeout });
            // A start element inside a dialog says nothing about the rest of the page: judge controls only when a scope is given.
            let candidates: Candidate[] | undefined;
            if (step.startSelector === undefined || step.scope !== undefined) {
              const answer = (await runTrustedScript(frame, 'keyboard-candidates', step.scope === undefined ? {} : { scope: step.scope }, secrets)) as unknown as {
                candidates: Candidate[];
                scopeFound: boolean;
              };
              if (!answer.scopeFound) throw new StepExecutionError('keyboardWalk: scope selector matched nothing');
              candidates = answer.candidates;
            }
            const walk = await walkKeyboard(
              {
                active: async () => (await runTrustedScript(frame, 'keyboard-active', {}, secrets)) as ActiveElement,
                press: () => page.keyboard.press('Tab'),
                styleOf: async (key) => {
                  const answer = (await runTrustedScript(frame, 'keyboard-style', { path: key }, secrets)) as { found?: boolean; signature?: StyleSignature };
                  return answer.found ? answer.signature : undefined;
                },
              },
              {
                maxTabs: step.maxTabs,
                startFocused: step.startSelector !== undefined,
                ...(candidates ? { candidates } : {}),
                deadline: Date.now() + Math.max(timeout * 3, 30000),
              },
            );
            extracted[step.name] = redactSecrets(walk, knownSecrets) as unknown as JsonValue;

            const failures = [
              step.failOn.includes('neverFocused') && (walk.neverFocused?.length ?? 0) > 0 ? `${walk.neverFocused!.length} control(s) never received keyboard focus` : undefined,
              step.failOn.includes('focusTrap') && walk.trap ? `focus trap: Tab loops over ${walk.trap.length} element(s) and never gets out` : undefined,
              step.failOn.includes('invisibleFocus') && walk.invisibleFocus.length > 0 ? `${walk.invisibleFocus.length} element(s) show no outline, shadow or border change when focused` : undefined,
            ].filter((message): message is string => message !== undefined);
            if (failures.length > 0) throw new StepExecutionError(`keyboardWalk: ${failures.join('; ')}`);
            break;
          }
          case 'auditAccessibility': {
            // T7.4/T7.5, with the built-in trusted script (T7.1): axe-core runs in the page, the caller names no code, so ALLOW_EVALUATE does not apply.
            const profile = request.targetProfile ? await getTarget(request.targetProfile).catch(() => undefined) : undefined;
            const raw = (await runTrustedScript(
              frame,
              'a11y-axe',
              { tags: STANDARD_TAGS[step.standard], maxNodesPerRule: 50, maxFindings: 500, ...(step.scope === undefined ? {} : { scope: step.scope }) },
              { knownSecrets },
            )) as unknown as RawAxeAnswer;
            if (!raw.scopeFound) throw new StepExecutionError('auditAccessibility: scope selector matched nothing');

            const audit = normalizeAxeAnswer(raw, {
              standard: step.standard,
              ...(step.scope === undefined ? {} : { scope: step.scope }),
              ...(step.rules ? { rules: step.rules } : {}),
              ...(profile?.diff ? { diff: profile.diff } : {}),
            });

            let delta: AccessibilityDelta | undefined;
            let baselineInfo: { screen: string; buildId: string; createdAt: string } | undefined;
            if (step.baseline) {
              const baselineTarget = step.baseline.targetProfile ?? request.targetProfile;
              if (!baselineTarget) throw new StepExecutionError('auditAccessibility: baseline needs a target profile (set baseline.targetProfile or run with a targetProfile)');
              let baseline: Awaited<ReturnType<typeof loadAccessibilityBaseline>>;
              try {
                baseline = await loadAccessibilityBaseline(baselineTarget, step.baseline.screen, step.baseline.build);
              } catch (error) {
                throw new StepExecutionError(`auditAccessibility: ${error instanceof Error ? error.message : 'the baseline could not be read'}`);
              }
              const comparison = compareAudits(baseline.audit, audit);
              if (!comparison.comparable) throw new StepExecutionError(`auditAccessibility: the baseline of build ${baseline.buildId} cannot be compared: ${comparison.reason}`);
              delta = comparison.delta;
              baselineInfo = { screen: step.baseline.screen, buildId: baseline.buildId, createdAt: baseline.createdAt };
            }

            extracted[step.name] = redactSecrets(
              { ...audit, ...(baselineInfo && delta ? { baseline: { ...baselineInfo, ...delta } } : {}) },
              knownSecrets,
            ) as unknown as JsonValue;

            const failure = failureFor(step.failOn, audit, delta);
            if (failure) throw new StepExecutionError(`auditAccessibility: ${failure}`);
            break;
          }
          case 'injectFault': {
            // T7.2: the policy was installed with the context because the run has this step; the allowlist is applied per request.
            const activeFaults = session.faults;
            if (!activeFaults) throw new StepExecutionError('injectFault: fault injection is not active for this run');
            activeFaults.add({
              match: step.match,
              fault: step.fault,
              ...(step.times === undefined ? {} : { times: step.times }),
              ...(step.untilStep === undefined ? {} : { untilStep: step.untilStep }),
            });
            break;
          }
          case 'assertNoTextMatches': {
            const text = await frame.locator(step.selector ?? 'body').first().innerText({ timeout });
            const findings = findLeaks(text, { kinds: step.kinds ?? ALL_LEAK_KINDS, ...(step.contains ? { contains: step.contains } : {}) });
            if (findings.length > 0) {
              // Kinds, counts and one short example each (redacted by the catch below); never the page.
              const summary = findings.map((finding) => `${finding.kind} x${finding.count} (e.g. "${finding.example}")`).join('; ');
              throw new StepExecutionError(`assertNoTextMatches: the page shows ${summary}`);
            }
            break;
          }
          case 'scanForPii': {
            // T7.8: reads only. The report keeps masked samples and fingerprints; the raw text was scanned in memory and dropped.
            const activePii = session.pii;
            if (!activePii) throw new StepExecutionError('scanForPii: the PII hunt is not active for this run');
            const surfaces = step.surfaces ?? PII_SURFACES;
            await activePii.scan(frame, surfaces);
            const report = activePii.report(surfaces);
            extracted[step.name] = redactSecrets(report, knownSecrets) as unknown as JsonValue;
            const failing = report.findings.filter((finding) => meetsFailLevel(finding.severity, step.failOn));
            if (failing.length > 0) {
              const worst = failing.reduce((a, b) => (SEVERITY_RANK[b.severity] > SEVERITY_RANK[a.severity] ? b : a));
              throw new StepExecutionError(
                `scanForPii: ${failing.length} finding(s) at "${step.failOn}" or above, e.g. ${worst.detector} (${worst.severity}) in ${worst.surface}: ${worst.location} = ${worst.maskedSample}`,
              );
            }
            break;
          }
          case 'setClock': {
            // T7.3: the browser's clock only (context-wide: every page and frame). The server's clock is the real one.
            const clock = session.ctx.context.clock;
            if (step.fixedTime !== undefined) {
              const at = new Date(step.fixedTime);
              await clock.setFixedTime(at);
              clockEvents.push({ ...(step.id ? { stepId: step.id } : {}), ...(step.actor ? { actor: step.actor } : {}), mode: 'fixed', time: at.toISOString() });
            } else {
              if (session.clockInstalled) {
                throw new StepExecutionError('setClock: installAt can be used once per run (installing again would restart the time); use fixedTime to move the clock');
              }
              const at = new Date(step.installAt!);
              await clock.install({ time: at });
              session.clockInstalled = true;
              if (step.fastForwardMs !== undefined) await clock.fastForward(step.fastForwardMs);
              clockEvents.push({
                ...(step.id ? { stepId: step.id } : {}),
                ...(step.actor ? { actor: step.actor } : {}),
                mode: 'install',
                time: at.toISOString(),
                ...(step.fastForwardMs === undefined ? {} : { fastForwardMs: step.fastForwardMs }),
              });
            }
            break;
          }
          case 'extractText':
            extracted[step.name] = await frame.locator(step.selector).innerText({ timeout });
            break;
          case 'extractAttribute':
            extracted[step.name] = await frame.locator(step.selector).getAttribute(step.attribute, { timeout });
            break;
          case 'evaluate':
            extracted[step.name] = capAndRedactEvaluateResult(await runEvaluate(frame, step.script), knownSecrets);
            break;
          case 'watch': {
            const started = Date.now();
            const maxSamples = Math.min(env.MAX_WATCH_SAMPLES, Math.ceil(step.durationMs / step.intervalMs) + 1);
            const samples: Array<{ t: number; value: JsonValue }> = [];

            while (Date.now() - started <= step.durationMs && samples.length < maxSamples) {
              const t = Date.now() - started;
              let value: unknown;

              try {
                value = await runEvaluate(frame, step.script);
              } catch (error) {
                value = { error: error instanceof Error ? error.message : 'watch evaluation failed' };
              }

              samples.push({ t, value: capAndRedactEvaluateResult(value, knownSecrets) });

              if (samples.length < maxSamples && Date.now() - started < step.durationMs) {
                await page.waitForTimeout(step.intervalMs);
              }
            }

            extracted[step.name] = capAndRedactEvaluateResult(samples, knownSecrets);
            break;
          }
          case 'waitForElapsed': {
            const finishedAt = stepFinishedAt.get(step.sinceStepId);
            if (finishedAt === undefined) {
              throw new StepExecutionError(`waitForElapsed: step "${step.sinceStepId}" has not finished`);
            }

            const remaining = step.minElapsedMs - (Date.now() - finishedAt);
            if (remaining > 0) {
              if (step.timeoutMs !== undefined && remaining > step.timeoutMs) {
                throw new StepExecutionError(`waitForElapsed: required wait ${remaining}ms exceeds timeoutMs ${step.timeoutMs}`);
              }

              await page.waitForTimeout(remaining);
            }
            break;
          }
          default:
            throw new StepExecutionError('Unsupported action');
        }

        if (responseWaiter) {
          await responseWaiter;
        } else if (step.afterWaitFor) {
          await applyWaitCondition(page, step.frame, step.afterWaitFor);
        }

        for (const other of [session, ...sessions.values()]) {
          const disallowedNavigationError = other.evidence.getDisallowedNavigationError();
          if (disallowedNavigationError) {
            throw new StepExecutionError(other === session || !multiActor ? disallowedNavigationError : `[actor ${other.name}] ${disallowedNavigationError}`);
          }
        }
      } catch (error) {
        responseWaiter?.catch(() => undefined);
        stepFailed = true;
        const message = error instanceof Error ? redactString(error.message, knownSecrets) : 'Unknown step error';
        stepResult.status = 'failed';
        stepResult.error = {
          type: error instanceof Error ? error.name : 'StepExecutionError',
          message,
        };
        if (phase === 'steps') {
          failedStepIndex = index;
          resultError = {
            type: stepResult.error.type,
            message,
          };
        }
      } finally {
        const finishedAt = new Date();
        stepResult.finishedAt = finishedAt.toISOString();
        stepResult.durationMs = finishedAt.getTime() - stepStartedAt.getTime();
        session.stepsRun += 1;
        (phase === 'steps' ? steps : teardownSteps).push(stepResult);
        if (step.id) {
          stepFinishedAt.set(step.id, finishedAt.getTime());
          // T7.2: a fault that was to last "until this step" ends now, pass or fail.
          for (const each of sessions.values()) each.faults?.stepFinished(step.id);
        }
      }

      // Evidence of the failing state is taken BEFORE teardown runs and changes the page.
      if (stepFailed && phase === 'steps') {
        if (screenshotMode === 'onFailure' || screenshotMode === 'always') {
          await evidence.captureScreenshot('failure');
        }

        if (request.options.collectDomOnFailure) {
          const domText = await evidence.collectDomText();
          if (domText) {
            domTextSnapshot = domText;
            session.domTextSnapshot = domText;
          }
        }
      }

      return stepFailed;
    };

    for (const [index, step] of request.steps.entries()) {
      if (await runStep(step, index, 'steps')) {
        break;
      }
    }

    // T7.8: storage, cookies and hidden inputs are read once, here: after the steps (logged in, on the last page) and before a teardown that may log out.
    if (request.options.piiScan) {
      for (const each of sessions.values()) await each.pii?.scan(each.ctx.page.mainFrame()).catch(() => undefined);
    }

    // Always runs once a browser exists, whether the steps passed or failed. Each teardown step is
    // attempted even if an earlier one failed: cleanup is best-effort and independent.
    // T7.2: faults of the steps end here, so the cleanup talks to the application as it really is (a teardown may inject its own).
    for (const each of sessions.values()) each.faults?.clear();
    for (const [index, step] of (request.teardown ?? []).entries()) {
      await runStep(step, index, 'teardown');
    }

    if (request.options.piiScan) {
      // The bodies still being read when the last step ended (teardown included) are waited for, bounded.
      const reports: Array<{ actor: string; report: PiiReport }> = [];
      for (const each of sessions.values()) {
        if (!each.pii) continue;
        await each.pii.settle();
        reports.push({ actor: each.name, report: each.pii.report() });
      }
      piiReport = multiActor ? mergePiiReports(reports) : reports[0]?.report;
    }

    // T3.1: the build the app reports (never fails the run, `unknown` when it cannot be read).
    if (request.buildProbe) {
      probedBuildId = await probeBuildId(request.buildProbe.info, request.buildProbe.baseUrl, primary.ctx.context);
    }
  } catch (error) {
    const message = error instanceof Error ? redactString(error.message, knownSecrets) : 'Unknown runner error';
    resultError = {
      type: error instanceof Error ? error.name : 'RunnerError',
      message,
    };
  } finally {
    // The run's own page is the first one that ran a step; every actor's last address is read BEFORE its page closes.
    for (const each of sessions.values()) each.finalUrl = each.ctx.page.url();
    finalUrl = [...sessions.values()][0]?.finalUrl ?? normalizedTargetUrl;
    if (traceOn) {
      for (const each of sessions.values()) {
        // trace.zip is main's (as it always was); another actor's is trace.<actor>.zip.
        const trace = artifactStore.tracePath(each.name === MAIN_ACTOR ? undefined : each.name);
        await each.ctx.context.tracing.stop({ path: trace.absolutePath }).catch(() => undefined);
        each.tracePath = trace.relativePath;
      }
      tracePath = (sessions.get(MAIN_ACTOR) ?? [...sessions.values()][0])?.tracePath;
    }
    for (const each of sessions.values()) await each.ctx.close();
    await browser?.close().catch(() => undefined);
  }

  const finishedAt = new Date();
  const status = failedStepIndex === undefined && !resultError ? 'passed' : 'failed';
  const maskOptions = { knownSecrets };
  const noiseRules = noiseRulesFor(profile);
  // T7.8: a run that hunts for secrets in URLs must not write the one it found into its own result (finalUrl keeps the query and the fragment).
  const recordable = (url: string | undefined): string | undefined => (hunting && url ? maskUrl(url, maskOptions) : url);
  const recordedUrl = recordable(finalUrl);
  // The evidence of ONE actor (T6.4). A run without actors has exactly one -- main's -- and it is the run's evidence, as it always was.
  const evidenceOf = (session: ActorSession | undefined, domText: string | undefined): EvidenceBlock => {
    const collected = session?.evidence;
    // T7.8: what a hunting run keeps as evidence must not hold the values it reports: console text, page errors, the URL a console line came from, the DOM text of a failure.
    const consoleEvidence = hunting
      ? (collected?.console ?? []).map((item) => ({
          ...item,
          text: maskText(item.text, maskOptions),
          ...(item.location ? { location: { ...item.location, ...(item.location.url ? { url: maskUrl(item.location.url, maskOptions) } : {}) } } : {}),
        }))
      : (collected?.console ?? []);
    const pageErrorEvidence = hunting ? (collected?.pageErrors ?? []).map((message) => maskText(message, maskOptions)) : (collected?.pageErrors ?? []);
    const domTextEvidence = hunting && domText ? maskText(domText, maskOptions) : domText;
    const networkEvidence = collected?.network ?? [];
    const routingEntries = session?.ctx.routing.entries ?? [];
    const sessionUrl = recordable(session ? session.finalUrl : finalUrl);
    // T8.1: known noise (the platform's, the profile's) is left out of the failures and counted apart; `network` keeps every request.
    const { kept: networkFailures, filtered: noiseFiltered } = applyNoiseFilters(
      networkEvidence.filter((item) => item.failureText || (item.status !== undefined && item.status >= 400)),
      noiseRules,
    );
    return {
      screenshots: collected?.screenshots ?? [],
      ...(session?.tracePath === undefined ? {} : { tracePath: session.tracePath }),
      console: consoleEvidence,
      consoleErrors: consoleEvidence.filter((item) => item.type === 'error'),
      pageErrors: pageErrorEvidence,
      network: networkEvidence,
      networkFailures,
      ...(noiseFiltered.length > 0 ? { noiseFiltered } : {}),
      unexpectedExternalRequests: collected?.unexpectedExternalRequests ?? [],
      ...(routingEntries.length > 0 ? { routing: routingEntries } : {}),
      ...(collected?.traffic ? { traffic: collected.traffic, ...(collected.trafficTruncated ? { trafficTruncated: true } : {}) } : {}),
      ...(domTextEvidence === undefined ? {} : { domTextSnapshot: domTextEvidence }),
      ...(sessionUrl === undefined ? {} : { finalUrl: sessionUrl }),
    };
  };
  const perActor = [...sessions.values()].map((session) => ({ session, actor: session.name, evidence: evidenceOf(session, session.domTextSnapshot) }));
  const runEvidence: EvidenceBlock = multiActor
    ? {
        ...mergeEvidence(perActor),
        ...(hunting && domTextSnapshot ? { domTextSnapshot: maskText(domTextSnapshot, maskOptions) } : domTextSnapshot ? { domTextSnapshot } : {}),
        ...(recordedUrl === undefined ? {} : { finalUrl: recordedUrl }),
      }
    : evidenceOf([...sessions.values()][0], domTextSnapshot);
  const rawResult: ExplorationResult = {
    jobId,
    scenarioName: request.scenarioName,
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    targetUrl: normalizedTargetUrl,
    caller: request.caller ?? null,
    ...(functional ? { profile: 'functional' as const } : {}),
    ...(clockEvents.length > 0 ? { clock: clockEvents } : {}),
    ...(piiReport ? { pii: piiReport } : {}),
    ...(request.parameterRecord ? { parameters: request.parameterRecord } : {}),
    ...(request.autoLogin ? { autoLogin: request.autoLogin } : {}),
    ...(request.includes ? { includes: request.includes } : {}),
    ...(request.teardown
      ? { teardown: teardownSteps, teardownStatus: teardownSteps.length === request.teardown.length && teardownSteps.every((s) => s.status === 'passed') ? ('passed' as const) : ('failed' as const) }
      : {}),
    ...(request.routine ? { routine: request.routine } : {}),
    ...(request.suite ? { suite: request.suite } : {}),
    ...(request.buildId
      ? { buildId: request.buildId, buildIdSource: 'provided' as const }
      : probedBuildId
        ? { buildId: probedBuildId, buildIdSource: probedBuildId === UNKNOWN_BUILD ? ('unknown' as const) : ('probe' as const) }
        : {}),
    finalUrl: recordedUrl,
    failedStepIndex,
    error: resultError,
    steps,
    extracted,
    // T6.4: each actor's own evidence, only when a step named an actor other than main. `evidence` below is then the merged view, every item tagged.
    ...(multiActor
      ? {
          actors: Object.fromEntries(
            perActor.map(({ session, evidence: block }) => [
              session.name,
              { ...(session.credentialSet === undefined ? {} : { credentialSet: session.credentialSet }), ...(block.finalUrl === undefined ? {} : { finalUrl: block.finalUrl }), stepsRun: session.stepsRun, evidence: block },
            ]),
          ),
        }
      : {}),
    evidence: runEvidence,
  };

  const result = redactSecrets(rawResult, knownSecrets);
  await saveJsonFile(artifactStore.resultPath().absolutePath, result);

  // Sanitized request for "save this run as a routine" (T1.3). Never the credential values: only
  // the credentialSet NAME survives. Values that equal a known secret are redacted as well.
  // `variables` are left out on purpose; they are per-run inputs, not part of a routine.
  await saveJsonFile(
    artifactStore.requestPath().absolutePath,
    redactSecrets(
      {
        scenarioName: request.scenarioName,
        targetUrl: normalizedTargetUrl,
        targetProfile: request.targetProfile,
        credentialSet: request.credentialSet,
        // T6.4: the actors' names, credential-set ids and viewports (never a value), so a good run saves as the routine it was.
        ...(request.actors ? { actors: request.actors } : {}),
        options: request.options,
        // T5.3: declared parameters (never the generated values or the seed: those are per run).
        ...(request.parameters ? { parameters: request.parameters } : {}),
        // T5.6: the exact values the run was forced to (a shrunk failure), so saving this run as a routine can pin them.
        ...(request.parameterValues ? { parameterValues: request.parameterValues } : {}),
        // As written, with include steps intact, so saving the run keeps the reuse.
        steps: request.unexpanded?.steps ?? request.steps,
        teardown: request.unexpanded?.teardown ?? request.teardown,
      },
      knownSecrets,
    ),
  ).catch(() => undefined);

  // Last file written: the manifest hashes everything above (T1.5). Like the history write below, a
  // failure here must never turn a finished run into a failed request.
  const retention = request.options.retention ?? 'ephemeral';
  await buildManifest(artifactStore.rootDir, jobId, retention)
    .then((manifest) => writeManifest(artifactStore.rootDir, manifest))
    // Never fails the run, but never silent either: a missing manifest later reads as "evidence not found".
    .catch((error) => void process.stderr.write(`[evidence] manifest of ${jobId} could not be written: ${error instanceof Error ? error.message : String(error)}
`));

  // Record in the durable index. appendRun() swallows its own errors by design: a history
  // write must never turn a successful exploration into a failed request.
  await appendRun(summarizeResult(result, retention));

  return result;
}
