import type { Request, Response, Page } from 'playwright';

import type { ArtifactStore } from '../artifacts/artifactStore.js';
import type { ConsoleEvidence, NetworkEvidence, ScreenshotEvidence } from '../schemas/explorationResult.schema.js';
import { isAllowedResourceUrl, validateTargetUrl } from '../security/validateTargetUrl.js';

const MAX_EVENT_ITEMS = 200;
const MAX_DOM_TEXT_CHARS = 20000;

export interface EvidenceCollector {
  screenshots: ScreenshotEvidence[];
  console: ConsoleEvidence[];
  pageErrors: string[];
  network: NetworkEvidence[];
  unexpectedExternalRequests: NetworkEvidence[];
  getDisallowedNavigationError(): string | undefined;
  captureScreenshot(name: string): Promise<ScreenshotEvidence>;
  collectDomText(): Promise<string | undefined>;
}

function pushCapped<T>(items: T[], item: T): void {
  items.push(item);
  if (items.length > MAX_EVENT_ITEMS) {
    items.shift();
  }
}

function sanitizeNetworkEvidence(input: {
  url: string;
  method: string;
  resourceType?: string;
  status?: number;
  failureText?: string;
  unexpectedExternalOrigin?: boolean;
}): NetworkEvidence {
  let origin = 'unknown';
  let pathname = '/';

  try {
    const parsed = new URL(input.url);
    origin = parsed.origin;
    pathname = parsed.pathname;
  } catch {
    pathname = 'invalid-url';
  }

  return {
    origin,
    pathname,
    method: input.method,
    resourceType: input.resourceType,
    status: input.status,
    failureText: input.failureText,
    unexpectedExternalOrigin: input.unexpectedExternalOrigin,
  };
}

function networkEvidenceFromRequest(request: Request, unexpectedExternalOrigin: boolean): NetworkEvidence {
  return sanitizeNetworkEvidence({
    url: request.url(),
    method: request.method(),
    resourceType: request.resourceType(),
    unexpectedExternalOrigin,
  });
}

function networkEvidenceFromResponse(response: Response): NetworkEvidence {
  const request = response.request();

  return sanitizeNetworkEvidence({
    url: response.url(),
    method: request.method(),
    resourceType: request.resourceType(),
    status: response.status(),
    unexpectedExternalOrigin: !isAllowedResourceUrl(response.url()),
  });
}

export function registerEvidenceCollectors(page: Page, artifactStore: ArtifactStore): EvidenceCollector {
  const screenshots: ScreenshotEvidence[] = [];
  const consoleEvents: ConsoleEvidence[] = [];
  const pageErrors: string[] = [];
  const network: NetworkEvidence[] = [];
  const unexpectedExternalRequests: NetworkEvidence[] = [];
  let disallowedNavigationError: string | undefined;

  page.on('console', (message) => {
    pushCapped(consoleEvents, {
      type: message.type(),
      text: message.text(),
      location: message.location(),
    });
  });

  page.on('pageerror', (error) => {
    pushCapped(pageErrors, error.message);
  });

  page.on('request', (request) => {
    const frame = request.frame();
    const isMainFrameNavigation = frame === page.mainFrame() && request.isNavigationRequest();

    if (isMainFrameNavigation) {
      try {
        validateTargetUrl(request.url());
      } catch (error) {
        disallowedNavigationError = error instanceof Error ? error.message : 'Main-frame navigation was not allowed';
      }
      return;
    }

    if (!isAllowedResourceUrl(request.url())) {
      const item = networkEvidenceFromRequest(request, true);
      pushCapped(unexpectedExternalRequests, item);
      pushCapped(network, item);
    }
  });

  page.on('requestfailed', (request) => {
    const item = sanitizeNetworkEvidence({
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      failureText: request.failure()?.errorText,
      unexpectedExternalOrigin: !isAllowedResourceUrl(request.url()),
    });
    pushCapped(network, item);
  });

  page.on('response', (response) => {
    if (response.status() < 400) {
      return;
    }

    const item = networkEvidenceFromResponse(response);
    pushCapped(network, item);
  });

  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) {
      return;
    }

    try {
      validateTargetUrl(frame.url());
    } catch (error) {
      disallowedNavigationError = error instanceof Error ? error.message : 'Main-frame navigation was not allowed';
    }
  });

  return {
    screenshots,
    console: consoleEvents,
    pageErrors,
    network,
    unexpectedExternalRequests,
    getDisallowedNavigationError() {
      return disallowedNavigationError;
    },
    async captureScreenshot(name: string) {
      const screenshotPath = artifactStore.screenshotPath(name);
      await page.screenshot({ path: screenshotPath.absolutePath, fullPage: true });
      const evidence = { name: screenshotPath.safeName, path: screenshotPath.relativePath };
      screenshots.push(evidence);
      return evidence;
    },
    async collectDomText() {
      const body = page.locator('body');
      const text = await body.innerText({ timeout: 1000 }).catch(() => undefined);
      return text ? text.slice(0, MAX_DOM_TEXT_CHARS) : undefined;
    },
  };
}
