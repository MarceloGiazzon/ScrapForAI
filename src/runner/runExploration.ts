import { setTimeout as sleep } from 'node:timers/promises';

import { nanoid } from 'nanoid';
import type { Frame, Page } from 'playwright';

import { createArtifactStore, saveJsonFile } from '../artifacts/artifactStore.js';
import { env } from '../config/env.js';
import { buildManifest, writeManifest } from '../evidence/manifest.js';
import { appendRun } from '../history/runHistoryStore.js';
import { summarizeResult } from '../history/summarizeResult.js';
import { checkAssertEquals } from '../oracle/assertEquals.js';
import { type FrameRef, type RunnableStep, stubbedResourceTypes, type WaitCondition } from '../schemas/explorationRequest.schema.js';
import type { ExplorationResult, JsonValue, StepResult } from '../schemas/explorationResult.schema.js';
import { assertCredentialOrigin } from '../security/credentialBinding.js';
import { collectKnownSecretValues, redactSecrets, redactString } from '../security/redactSecrets.js';
import { validateTargetUrl } from '../security/validateTargetUrl.js';
import { probeBuildId, UNKNOWN_BUILD } from './buildProbe.js';
import { type EvidenceCollector, registerEvidenceCollectors } from './collectEvidence.js';
import { extractStructure } from './extractStructure.js';
import type { ResolvedExplorationRequest } from './resolveRequest.js';
import { createPlaywrightContext, type PlaywrightJobContext } from './playwrightContext.js';

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

function resolveValue(step: RunnableStep, request: ResolvedExplorationRequest, targetFrame: Frame): string {
  if ('value' in step && step.value !== undefined) {
    return step.value;
  }

  if ('valueFromCredential' in step && step.valueFromCredential !== undefined) {
    const value = request.credentials?.[step.valueFromCredential];
    if (value === undefined) {
      throw new StepExecutionError('Credential value was not provided');
    }
    // Vault-sourced values may only be typed into pages of their bound origins (T1.2).
    assertCredentialOrigin(request.credentialBinding, step.valueFromCredential, targetFrame.url());
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
  const knownSecrets = collectKnownSecretValues(request.credentials, { SCRAPFORAI_API_KEY: env.SCRAPFORAI_API_KEY });
  const jobId = `job_${nanoid(12)}`;
  const startedAt = new Date();
  const normalizedTargetUrl = validateTargetUrl(request.targetUrl);
  const artifactStore = await createArtifactStore(jobId);
  // T5.2: a functional run keeps no screenshots and no trace, whatever the options say.
  const functional = request.options.profile === 'functional';
  const screenshotMode = functional ? 'off' : request.options.screenshots;
  const traceOn = functional ? false : request.options.trace;
  let playwright: PlaywrightJobContext | undefined;
  let evidence: EvidenceCollector | undefined;
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

  try {
    // FORCE_HEADLESS (set by the Light distribution, which bundles only the headless shell)
    // overrides a headed request so it degrades to headless instead of failing to launch a
    // browser that was never bundled.
    const headless = env.FORCE_HEADLESS || request.options.headless;
    playwright = await createPlaywrightContext(headless, request.options.viewport, { stubResources: stubbedResourceTypes(request.options) });
    evidence = registerEvidenceCollectors(playwright.page, artifactStore, playwright.routing.isHandled);

    if (traceOn) {
      await playwright.context.tracing.start({ screenshots: false, snapshots: true, sources: false });
    }

    // One step, in either phase. Teardown (T1.4) uses the same machinery but must not touch the verdict:
    // its failures stay in teardownSteps and never set failedStepIndex/resultError.
    // Narrowed here, once, because TypeScript does not carry the narrowing of `let` variables into closures.
    const activePlaywright = playwright;
    const activeEvidence = evidence;
    const runStep = async (step: RunnableStep, index: number, phase: 'steps' | 'teardown'): Promise<boolean> => {
      const playwright = activePlaywright;
      const evidence = activeEvidence;
      let stepFailed = false;
      const stepStartedAt = new Date();
      let responseWaiter: Promise<unknown> | undefined;
      const stepResult: StepResult = {
        index,
        id: step.id,
        label: step.label,
        description: step.description,
        action: step.action,
        status: 'passed',
        startedAt: stepStartedAt.toISOString(),
        finishedAt: stepStartedAt.toISOString(),
        durationMs: 0,
      };

      try {
        const page = playwright.page;
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
            await playwright.context.setOffline(step.offline);
            break;
          case 'waitForLoadState':
            await frame.waitForLoadState(step.state, { timeout });
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
            const cdp = await playwright!.browser.newBrowserCDPSession();
            try {
              const { targetInfos } = await cdp.send('Target.getTargets', {}) as { targetInfos: Array<{ targetId: string; type: string }> };
              const target = targetInfos.find((t) => t.type === 'page');
              if (!target) {
                throw new StepExecutionError('resizeWindow: no page target found via CDP');
              }
              const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: target.targetId }) as { windowId: number };
              await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: step.width, height: step.height } });
            } finally {
              await cdp.detach().catch(() => undefined);
            }
            await page.setViewportSize({ width: step.width, height: step.height });
            break;
          }
          case 'fill':
            await frame.locator(step.selector).fill(resolveValue(step, request, frame), { timeout });
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
            await frame.locator(step.selector).selectOption(resolveValue(step, request, frame), { timeout });
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

        const disallowedNavigationError = evidence.getDisallowedNavigationError();
        if (disallowedNavigationError) {
          throw new StepExecutionError(disallowedNavigationError);
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
        (phase === 'steps' ? steps : teardownSteps).push(stepResult);
        if (step.id) {
          stepFinishedAt.set(step.id, finishedAt.getTime());
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

    // Always runs once a browser exists, whether the steps passed or failed. Each teardown step is
    // attempted even if an earlier one failed: cleanup is best-effort and independent.
    for (const [index, step] of (request.teardown ?? []).entries()) {
      await runStep(step, index, 'teardown');
    }

    // T3.1: the build the app reports (never fails the run, `unknown` when it cannot be read).
    if (request.buildProbe) {
      probedBuildId = await probeBuildId(request.buildProbe.info, request.buildProbe.baseUrl, playwright.context);
    }
  } catch (error) {
    const message = error instanceof Error ? redactString(error.message, knownSecrets) : 'Unknown runner error';
    resultError = {
      type: error instanceof Error ? error.name : 'RunnerError',
      message,
    };
  } finally {
    finalUrl = playwright?.page.url() ?? normalizedTargetUrl;
    if (traceOn && playwright) {
      const trace = artifactStore.tracePath();
      await playwright.context.tracing.stop({ path: trace.absolutePath }).catch(() => undefined);
      tracePath = trace.relativePath;
    }
    await playwright?.close();
  }

  const finishedAt = new Date();
  const status = failedStepIndex === undefined && !resultError ? 'passed' : 'failed';
  const consoleEvidence = evidence?.console ?? [];
  const networkEvidence = evidence?.network ?? [];
  const consoleErrors = consoleEvidence.filter((item) => item.type === 'error');
  const routingEntries = playwright?.routing.entries ?? [];
  const networkFailures = networkEvidence.filter((item) => item.failureText || (item.status !== undefined && item.status >= 400));
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
    ...(request.parameterRecord ? { parameters: request.parameterRecord } : {}),
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
    finalUrl,
    failedStepIndex,
    error: resultError,
    steps,
    extracted,
    evidence: {
      screenshots: evidence?.screenshots ?? [],
      tracePath,
      console: consoleEvidence,
      consoleErrors,
      pageErrors: evidence?.pageErrors ?? [],
      network: networkEvidence,
      networkFailures,
      unexpectedExternalRequests: evidence?.unexpectedExternalRequests ?? [],
      ...(routingEntries.length > 0 ? { routing: routingEntries } : {}),
      domTextSnapshot,
      finalUrl,
    },
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
