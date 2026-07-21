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

export async function createPlaywrightContext(
  headless: boolean,
  viewport: Viewport = DEFAULT_VIEWPORT,
): Promise<PlaywrightJobContext> {
  const browserType = { chromium, firefox, webkit }[env.PLAYWRIGHT_BROWSER];
  const browser = await browserType.launch({ headless });
  const context = await browser.newContext({
    viewport,
    ignoreHTTPSErrors: false,
  });

  // tsx transpiles with esbuild `keepNames`, which injects `__name(fn, "fn")`
  // calls into functions to preserve their .name. That helper lives in Node
  // module scope, so a compiled function passed to page.evaluate (e.g. the DOM
  // snapshot in inspectDom.ts) throws "ReferenceError: __name is not defined" in
  // the browser. Define a no-op shim in every new document. Use a raw string
  // (the { content } form) so esbuild never transforms the shim itself.
  await context.addInitScript({
    content: 'globalThis.__name = globalThis.__name || function (value) { return value; };',
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
