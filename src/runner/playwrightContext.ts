import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page } from 'playwright';

import { env } from '../config/env.js';
import { installNetworkTracker } from './networkQuiet.js';
import { buildPolicies, installRouting, resourceStubPolicy, type Policy, type RoutingHandle } from './routing.js';

export interface PlaywrightJobContext {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** T5.1: the request interception of this context (inactive when no policy is on). */
  routing: RoutingHandle;
  close(): Promise<void>;
}

/** T6.4: one actor's isolated browser context and its page, inside a browser that several actors share. */
export interface ActorContext {
  context: BrowserContext;
  page: Page;
  routing: RoutingHandle;
  close(): Promise<void>;
}

export interface Viewport {
  width: number;
  height: number;
}

const DEFAULT_VIEWPORT: Viewport = { width: 1366, height: 768 };

// Playwright's bundled Chromium advertises itself as HeadlessChrome/<build>
// (a Chrome-for-Testing build), and Google rejects that user agent at the OAuth
// sign-in screen with "this browser or app may not be secure" (disallowed_useragent)
// -- observed live during the WmsOffice Google-link flow (SEC-11 / Session 3b
// verification). The target under test is the operator's OWN generated app; this
// only normalizes how the harness browser presents itself to Google, it does not
// touch the allowlist security model. The version MUST match the bundled Chromium
// build (probe: navigator.userAgent reported HeadlessChrome/148.0.7778.96): Google
// cross-checks the Sec-CH-UA header, which advertises the REAL build version, so a
// UA claiming any other version is an inconsistency Google can flag.
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.96 Safari/537.36';

export interface ContextOptions {
  /** Overrides BLOCK_UNEXPECTED_RESOURCES for this context. */
  blockUnexpected?: boolean;
  /** T5.2: resource types answered with a stand-in (see resourceStubPolicy). */
  stubResources?: readonly string[];
  /** T7.2: the fault policy of this run (only passed when a step injects faults, so a run without them installs nothing). */
  faults?: Policy;
  /** T8.2: install the pending-request counter (only for a run that waits for network quiet, so any other run is untouched). */
  networkTracker?: boolean;
}

/** Starts the browser a run (and all its actors) shares. */
export async function launchBrowser(headless: boolean): Promise<Browser> {
  const browserType = { chromium, firefox, webkit }[env.PLAYWRIGHT_BROWSER];
  return browserType.launch({
    headless,
    ...(env.PLAYWRIGHT_CHANNEL ? { channel: env.PLAYWRIGHT_CHANNEL } : {}),
  });
}

export async function createPlaywrightContext(
  headless: boolean,
  viewport: Viewport = DEFAULT_VIEWPORT,
  options: ContextOptions = {},
): Promise<PlaywrightJobContext> {
  const browser = await launchBrowser(headless);
  try {
    const opened = await openActorContext(browser, viewport, options);
    return {
      browser,
      context: opened.context,
      page: opened.page,
      routing: opened.routing,
      async close() {
        await opened.close();
        await browser.close().catch(() => undefined);
      },
    };
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }
}

/**
 * A new browser context with everything a run needs installed (init scripts, the request interception) and one page. Each context has its
 * own cookies, storage and cache, which is what keeps two actors from sharing a session (T6.4).
 */
export async function openActorContext(
  browser: Browser,
  viewport: Viewport = DEFAULT_VIEWPORT,
  options: ContextOptions = {},
): Promise<ActorContext> {
  const context = await browser.newContext({
    viewport,
    ignoreHTTPSErrors: false,
    // A real browser (PLAYWRIGHT_CHANNEL set) has its own genuine UA + Sec-CH-UA pair --
    // overriding it would recreate the inconsistency Google flags. Only the bundled
    // Chrome-for-Testing build needs the normalized UA.
    ...(env.PLAYWRIGHT_CHANNEL ? {} : { userAgent: CHROME_UA }),
  });

  // tsx transpiles with esbuild `keepNames`, which injects `__name(fn, "fn")`
  // calls into functions to preserve their .name. That helper lives in Node
  // module scope, so a compiled function passed to page.evaluate (e.g. the DOM
  // snapshot in inspectDom.ts) throws "ReferenceError: __name is not defined" in
  // the browser. Define a no-op shim in every new document. Use a raw string
  // (the { content } form) so esbuild never transforms the shim itself.
  await context.addInitScript({
    content: `globalThis.__name = globalThis.__name || function (value) { return value; };
Object.defineProperty(navigator, 'webdriver', { get: function () { return undefined; } });`,
  });

  if (options.networkTracker) {
    await installNetworkTracker(context);
  }

  const routing = await installRouting(context, buildPolicies({
      blockUnexpected: options.blockUnexpected ?? env.BLOCK_UNEXPECTED_RESOURCES,
      ...(options.faults ? { faults: [options.faults] } : {}),
      ...(options.stubResources && options.stubResources.length > 0 ? { resources: [resourceStubPolicy(options.stubResources)] } : {}),
    }));

  const page = await context.newPage();

  return {
    context,
    page,
    routing,
    async close() {
      await page.close().catch(() => undefined);
      await context.close().catch(() => undefined);
    },
  };
}
