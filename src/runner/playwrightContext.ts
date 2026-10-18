import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page } from 'playwright';

import { env } from '../config/env.js';

export interface PlaywrightJobContext {
  browser: Browser;
  context: BrowserContext;
  page: Page;
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

export async function createPlaywrightContext(
  headless: boolean,
  viewport: Viewport = DEFAULT_VIEWPORT,
): Promise<PlaywrightJobContext> {
  const browserType = { chromium, firefox, webkit }[env.PLAYWRIGHT_BROWSER];
  const browser = await browserType.launch({
    headless,
    ...(env.PLAYWRIGHT_CHANNEL ? { channel: env.PLAYWRIGHT_CHANNEL } : {}),
  });
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

  const page = await context.newPage();

  return {
    browser,
    context,
    page,
    async close() {
      await page.close().catch(() => undefined);
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    },
  };
}
