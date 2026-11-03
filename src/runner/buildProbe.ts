import type { BrowserContext } from 'playwright';

import { validateTargetUrl } from '../security/validateTargetUrl.js';
import type { TargetProfile } from '../schemas/targetProfile.schema.js';

/**
 * T3.1 build context: which build of the application did this run test?
 *
 * The target profile's `buildInfo` says where the build id lives. The probe runs AFTER the steps and the teardown, in the
 * run's own browser context (so a footer or endpoint behind the login answers), on a second page and through the context's
 * request client: the evidence collectors listen on the main page only, so the probe adds nothing to the run's evidence.
 * It never fails a run: any problem is `unknown`. A build id the caller passed always wins over a probed one.
 */

export type BuildInfo = NonNullable<TargetProfile['buildInfo']>;
export type BuildIdSource = 'provided' | 'probe' | 'unknown';

export const UNKNOWN_BUILD = 'unknown';
const PROBE_TIMEOUT_MS = 8_000;
const MAX_LENGTH = 100;

/** A value read from the app, made into something `buildIdSchema` accepts ([\w.+\-/]{1,100}); undefined when nothing usable is left. */
export function sanitizeBuildId(raw: unknown): string | undefined {
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
  const cleaned = String(raw)
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^\w.+\-/]/g, '')
    .slice(0, MAX_LENGTH);
  return cleaned.length > 0 ? cleaned : undefined;
}

/** `a.b.c`, `a[0].b` and `$.a.b`: the only JSON paths a build endpoint needs. Undefined when the path does not lead to a value. */
export function readJsonPath(value: unknown, jsonPath: string): unknown {
  const tokens = jsonPath
    .replace(/^\$\.?/, '')
    .split(/[.[\]]/)
    .filter((token) => token.length > 0);
  return walk(value, tokens);
}

/**
 * Walks `tokens` into `current`. An object key may itself contain dots (Spring's actuator answers `{"npdev.builtAt": ...}`),
 * so at each object the shortest run of tokens that is an own key is taken first, then longer ones.
 */
function walk(current: unknown, tokens: string[]): unknown {
  if (tokens.length === 0) return current;
  if (current === null || typeof current !== 'object') return undefined;
  if (Array.isArray(current)) {
    return /^\d+$/.test(tokens[0]!) ? walk(current[Number(tokens[0])], tokens.slice(1)) : undefined;
  }
  for (let take = 1; take <= tokens.length; take += 1) {
    const key = tokens.slice(0, take).join('.');
    if (!Object.hasOwn(current, key)) continue;
    const found = walk((current as Record<string, unknown>)[key], tokens.slice(take));
    if (found !== undefined) return found;
  }
  return undefined;
}

function absolute(url: string, baseUrl: string): string {
  return validateTargetUrl(url.startsWith('/') ? new URL(url, baseUrl).toString() : url);
}

async function read(info: BuildInfo, baseUrl: string, context: BrowserContext): Promise<string | undefined> {
  switch (info.kind) {
    case 'provided':
      return undefined;

    case 'httpHeader': {
      // Redirects are not followed: the probe never leaves the URL that was validated.
      const response = await context.request.get(validateTargetUrl(baseUrl), { maxRedirects: 0, timeout: PROBE_TIMEOUT_MS, failOnStatusCode: false });
      return sanitizeBuildId(response.headers()[info.header.toLowerCase()]);
    }

    case 'jsonEndpoint': {
      const response = await context.request.get(absolute(info.url, baseUrl), { maxRedirects: 0, timeout: PROBE_TIMEOUT_MS, failOnStatusCode: false });
      if (!response.ok()) return undefined;
      return sanitizeBuildId(readJsonPath(await response.json(), info.jsonPath));
    }

    case 'selectorText': {
      const page = await context.newPage();
      try {
        await page.goto(absolute(info.url, baseUrl), { waitUntil: 'domcontentloaded', timeout: PROBE_TIMEOUT_MS });
        validateTargetUrl(page.url()); // a redirect to somewhere else is not read
        const element = page.locator(info.selector).first();
        await element.waitFor({ state: 'attached', timeout: 3_000 });
        return sanitizeBuildId(await element.innerText({ timeout: 3_000 }));
      } finally {
        await page.close().catch(() => undefined);
      }
    }
  }
}

/** The build id the application reports, or `unknown`. Never throws. `provided` has nothing to probe: returns undefined. */
export async function probeBuildId(info: BuildInfo, baseUrl: string, context: BrowserContext): Promise<string | undefined> {
  if (info.kind === 'provided') return undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    const found = await Promise.race([
      read(info, baseUrl, context),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), PROBE_TIMEOUT_MS + 2_000);
      }),
    ]);
    return found ?? UNKNOWN_BUILD;
  } catch {
    return UNKNOWN_BUILD;
  } finally {
    clearTimeout(timer);
  }
}
