import type { ConsoleMessage, Page, Request, Response } from 'playwright';

import { env } from '../config/env.js';
import type { DomInspectionRequest } from '../schemas/domInspectionRequest.schema.js';
import { redactSecrets, redactString } from '../security/redactSecrets.js';
import { isAllowedResourceUrl, validateTargetUrl } from '../security/validateTargetUrl.js';
import { createPlaywrightContext } from './playwrightContext.js';

const MAX_CONTROLS = 300;
const MAX_FORMS = 50;
const MAX_ATTRS_PER_ELEMENT = 30;
const MAX_ATTR_VALUE_CHARS = 300;
const MAX_CONTROL_TEXT_CHARS = 500;
const MAX_LABEL_CONTEXT_CHARS = 500;
const MAX_CONSOLE_MESSAGES = 100;
const MAX_PAGE_ERRORS = 50;
const MAX_NETWORK_EVENTS = 200;
const SENSITIVE_ATTR_PATTERN = /(password|token|secret|session|key|auth|cookie|state)/i;

interface DomNetworkEvidence {
  origin: string;
  pathname: string;
  method: string;
  resourceType?: string;
  status?: number;
  failureText?: string;
  unexpectedExternalOrigin?: boolean;
}

interface DomConsoleEvidence {
  type: string;
  text: string;
  location?: {
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
  };
}

interface DomInspectionControl {
  index: number;
  tag: string;
  id?: string;
  name?: string;
  type?: string;
  role?: string;
  className?: string;
  visible: boolean;
  disabled: boolean;
  readonly: boolean;
  text?: string;
  labelContext?: string;
  attrs: Record<string, string>;
  selectors: string[];
  rect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

interface DomInspectionForm {
  index: number;
  id?: string;
  name?: string;
  method?: string;
  action?: string;
  selectors: string[];
  controlIndexes: number[];
}

export interface DomInspectionResult {
  status: 'passed' | 'failed';
  inspectedAt: string;
  targetUrl: string;
  finalUrl?: string;
  title?: string;
  bodyText?: string;
  forms: DomInspectionForm[];
  visibleControls: DomInspectionControl[];
  allControls: DomInspectionControl[];
  consoleMessages: DomConsoleEvidence[];
  pageErrors: string[];
  network: DomNetworkEvidence[];
  renderedHtml?: string;
  sensitiveOutput: boolean;
  warning?: string;
  error?: {
    type: string;
    message: string;
  };
}

function pushCapped<T>(items: T[], item: T, maxItems: number): void {
  items.push(item);
  if (items.length > maxItems) {
    items.shift();
  }
}

function sanitizeNetworkUrl(url: string): Pick<DomNetworkEvidence, 'origin' | 'pathname'> {
  try {
    const parsed = new URL(url);
    return {
      origin: parsed.origin,
      pathname: parsed.pathname,
    };
  } catch {
    return {
      origin: 'unknown',
      pathname: 'invalid-url',
    };
  }
}

function networkFromRequest(request: Request): DomNetworkEvidence {
  return {
    ...sanitizeNetworkUrl(request.url()),
    method: request.method(),
    resourceType: request.resourceType(),
    unexpectedExternalOrigin: !isAllowedResourceUrl(request.url()),
  };
}

function networkFromResponse(response: Response): DomNetworkEvidence {
  const request = response.request();
  return {
    ...sanitizeNetworkUrl(response.url()),
    method: request.method(),
    resourceType: request.resourceType(),
    status: response.status(),
    unexpectedExternalOrigin: !isAllowedResourceUrl(response.url()),
  };
}

function consoleFromMessage(message: ConsoleMessage): DomConsoleEvidence {
  return {
    type: message.type(),
    text: message.text().slice(0, MAX_CONTROL_TEXT_CHARS),
    location: message.location(),
  };
}

export async function inspectDom(request: DomInspectionRequest): Promise<DomInspectionResult> {
  const inspectedAt = new Date().toISOString();
  const targetUrl = validateTargetUrl(request.targetUrl);
  const consoleMessages: DomConsoleEvidence[] = [];
  const pageErrors: string[] = [];
  const network: DomNetworkEvidence[] = [];
  const playwright = await createPlaywrightContext(true, request.viewport);
  let finalUrl = targetUrl;
  let disallowedNavigationError: Error | undefined;

  try {
    const page = playwright.page;

    registerInspectionListeners(page, {
      includeConsole: request.includeConsole,
      includeNetwork: request.includeNetwork,
      consoleMessages,
      pageErrors,
      network,
      setDisallowedNavigationError(error) {
        disallowedNavigationError = error;
      },
    });

    const response = await page.goto(targetUrl, { waitUntil: request.waitUntil, timeout: request.timeoutMs });
    if (response) {
      validateTargetUrl(response.url());
    }

    finalUrl = page.url();
    validateTargetUrl(finalUrl);

    if (disallowedNavigationError) {
      throw disallowedNavigationError;
    }

    const snapshot = await extractDomSnapshot(page, {
      includeHiddenControls: request.includeHiddenControls,
      includeRenderedHtml: request.includeRenderedHtml,
      redactSensitiveValues: request.redactSensitiveValues,
      maxDomSnapshotChars: env.MAX_DOM_SNAPSHOT_CHARS,
    });

    return redactSecrets({
      status: 'passed',
      inspectedAt,
      targetUrl,
      finalUrl,
      title: snapshot.title,
      bodyText: snapshot.bodyText,
      forms: snapshot.forms,
      visibleControls: snapshot.visibleControls,
      allControls: snapshot.allControls,
      consoleMessages,
      pageErrors,
      network,
      renderedHtml: snapshot.renderedHtml,
      sensitiveOutput: request.includeRenderedHtml,
      warning: request.includeRenderedHtml
        ? 'renderedHtml can contain sensitive hidden state even after sanitization; request it only when necessary.'
        : undefined,
    } satisfies DomInspectionResult);
  } catch (error) {
    return {
      status: 'failed',
      inspectedAt,
      targetUrl,
      finalUrl,
      forms: [],
      visibleControls: [],
      allControls: [],
      consoleMessages,
      pageErrors,
      network,
      sensitiveOutput: request.includeRenderedHtml,
      warning: request.includeRenderedHtml
        ? 'renderedHtml can contain sensitive hidden state even after sanitization; request it only when necessary.'
        : undefined,
      error: {
        type: error instanceof Error ? error.name : 'DomInspectionError',
        message: error instanceof Error ? redactString(error.message) : 'DOM inspection failed',
      },
    };
  } finally {
    await playwright.close();
  }
}

function registerInspectionListeners(
  page: Page,
  options: {
    includeConsole: boolean;
    includeNetwork: boolean;
    consoleMessages: DomConsoleEvidence[];
    pageErrors: string[];
    network: DomNetworkEvidence[];
    setDisallowedNavigationError(error: Error): void;
  },
): void {
  page.on('console', (message) => {
    if (options.includeConsole) {
      pushCapped(options.consoleMessages, consoleFromMessage(message), MAX_CONSOLE_MESSAGES);
    }
  });

  page.on('pageerror', (error) => {
    pushCapped(options.pageErrors, error.message.slice(0, MAX_CONTROL_TEXT_CHARS), MAX_PAGE_ERRORS);
  });

  page.on('request', (request) => {
    const frame = request.frame();
    const isMainFrameNavigation = frame === page.mainFrame() && request.isNavigationRequest();

    if (isMainFrameNavigation) {
      try {
        validateTargetUrl(request.url());
      } catch (error) {
        options.setDisallowedNavigationError(error instanceof Error ? error : new Error('Main-frame navigation was not allowed'));
      }
      return;
    }

    if (options.includeNetwork) {
      pushCapped(options.network, networkFromRequest(request), MAX_NETWORK_EVENTS);
    }
  });

  page.on('requestfailed', (request) => {
    if (!options.includeNetwork) {
      return;
    }

    pushCapped(
      options.network,
      {
        ...networkFromRequest(request),
        failureText: request.failure()?.errorText?.slice(0, MAX_ATTR_VALUE_CHARS),
      },
      MAX_NETWORK_EVENTS,
    );
  });

  page.on('response', (response) => {
    if (options.includeNetwork) {
      pushCapped(options.network, networkFromResponse(response), MAX_NETWORK_EVENTS);
    }
  });

  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) {
      return;
    }

    try {
      validateTargetUrl(frame.url());
    } catch (error) {
      options.setDisallowedNavigationError(error instanceof Error ? error : new Error('Main-frame navigation was not allowed'));
    }
  });
}

async function extractDomSnapshot(
  page: Page,
  options: {
    includeHiddenControls: boolean;
    includeRenderedHtml: boolean;
    redactSensitiveValues: boolean;
    maxDomSnapshotChars: number;
  },
): Promise<{
  title: string;
  bodyText: string;
  forms: DomInspectionForm[];
  visibleControls: DomInspectionControl[];
  allControls: DomInspectionControl[];
  renderedHtml?: string;
}> {
  return page.evaluate(
    ({ limits, snapshotOptions }) => {
      const sensitivePattern = /(password|token|secret|session|key|auth|cookie|state)/i;
      const controlSelector = [
        'input',
        'textarea',
        'select',
        'button',
        'a[href]',
        '[role]',
        '[contenteditable="true"]',
        '[tabindex]',
        '[onclick]',
      ].join(',');

      function truncate(value: string | null | undefined, maxLength: number): string | undefined {
        if (!value) {
          return undefined;
        }
        return value.replace(/\s+/g, ' ').trim().slice(0, maxLength) || undefined;
      }

      function isVisible(element: Element): boolean {
        const htmlElement = element as HTMLElement;
        const style = window.getComputedStyle(htmlElement);
        const rect = htmlElement.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      }

      function cssEscape(value: string): string {
        if (window.CSS?.escape) {
          return window.CSS.escape(value);
        }
        return value.replace(/["\\#.[\]:]/g, '\\$&');
      }

      function quoteAttr(value: string): string {
        return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      }

      function shouldRedact(element: Element, attrName?: string): boolean {
        if (!snapshotOptions.redactSensitiveValues) {
          return false;
        }

        const htmlElement = element as HTMLInputElement;
        const candidate = [
          attrName,
          element.tagName,
          htmlElement.type,
          htmlElement.name,
          htmlElement.id,
          element.getAttribute('autocomplete'),
          element.getAttribute('aria-label'),
          element.getAttribute('data-testid'),
        ]
          .filter(Boolean)
          .join(' ');

        if (htmlElement.type?.toLowerCase() === 'hidden') {
          return true;
        }

        return sensitivePattern.test(candidate);
      }

      function safeValue(element: Element, attrName: string, value: string): string {
        if (shouldRedact(element, attrName)) {
          return '[REDACTED]';
        }
        return value.slice(0, limits.maxAttrValueChars);
      }

      function collectAttrs(element: Element): Record<string, string> {
        const attrs: Record<string, string> = {};
        for (const attr of Array.from(element.attributes).slice(0, limits.maxAttrsPerElement)) {
          attrs[attr.name] = safeValue(element, attr.name, attr.value);
        }
        return attrs;
      }

      function selectorsFor(element: Element): string[] {
        const tag = element.tagName.toLowerCase();
        const id = (element as HTMLElement).id;
        const name = element.getAttribute('name');
        const type = element.getAttribute('type');
        const selectors: string[] = [];

        if (id) {
          selectors.push(`#${cssEscape(id)}`);
        }
        if (name) {
          selectors.push(`${tag}[name="${quoteAttr(name)}"]`);
        }
        if (type) {
          selectors.push(`${tag}[type="${quoteAttr(type)}"]`);
        }
        if (id && type) {
          selectors.push(`${tag}#${cssEscape(id)}[type="${quoteAttr(type)}"]`);
        }
        if (name && type) {
          selectors.push(`${tag}[name="${quoteAttr(name)}"][type="${quoteAttr(type)}"]`);
        }

        return [...new Set(selectors)].slice(0, 5);
      }

      function labelContextFor(element: Element): string | undefined {
        const htmlElement = element as HTMLElement;
        const labels = (htmlElement as HTMLInputElement).labels;
        const labelTexts = labels ? Array.from(labels).map((label) => truncate(label.innerText, limits.maxLabelContextChars)).filter(Boolean) : [];
        const ariaLabel = truncate(element.getAttribute('aria-label'), limits.maxLabelContextChars);
        const labelledBy = element.getAttribute('aria-labelledby')
          ?.split(/\s+/)
          .map((id) => truncate(document.getElementById(id)?.innerText, limits.maxLabelContextChars))
          .filter(Boolean);
        const nearbyText = truncate(element.closest('label')?.textContent ?? element.parentElement?.textContent, limits.maxLabelContextChars);

        return [...labelTexts, ariaLabel, ...(labelledBy ?? []), nearbyText].find(Boolean);
      }

      function controlText(element: Element): string | undefined {
        const htmlElement = element as HTMLInputElement;

        if (shouldRedact(element)) {
          return '[REDACTED]';
        }

        if ('value' in htmlElement && htmlElement.value) {
          return truncate(htmlElement.value, limits.maxControlTextChars);
        }

        return truncate((element as HTMLElement).innerText ?? element.textContent, limits.maxControlTextChars);
      }

      function rectFor(element: Element) {
        const rect = (element as HTMLElement).getBoundingClientRect();
        return {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      }

      const controls = Array.from(document.querySelectorAll(controlSelector))
        .map((element, index) => {
          const htmlElement = element as HTMLInputElement;
          const visible = isVisible(element);
          return {
            index,
            tag: element.tagName.toLowerCase(),
            id: htmlElement.id || undefined,
            name: htmlElement.name || element.getAttribute('name') || undefined,
            type: htmlElement.type || element.getAttribute('type') || undefined,
            role: element.getAttribute('role') || undefined,
            className: typeof htmlElement.className === 'string' ? truncate(htmlElement.className, limits.maxAttrValueChars) : undefined,
            visible,
            disabled: Boolean(htmlElement.disabled || element.getAttribute('aria-disabled') === 'true'),
            readonly: Boolean(htmlElement.readOnly || element.getAttribute('aria-readonly') === 'true'),
            text: controlText(element),
            labelContext: labelContextFor(element),
            attrs: collectAttrs(element),
            selectors: selectorsFor(element),
            rect: rectFor(element),
          };
        })
        .filter((control) => snapshotOptions.includeHiddenControls || control.visible)
        .slice(0, limits.maxControls);

      const visibleControls = controls.filter((control) => control.visible).slice(0, limits.maxControls);

      const forms = Array.from(document.forms)
        .slice(0, limits.maxForms)
        .map((form, index) => {
          const formControls = controls
            .filter((control) => {
              const selector = control.selectors[0];
              if (!selector) {
                return false;
              }
              const element = document.querySelector(selector);
              return element instanceof HTMLElement && 'form' in element && element.form === form;
            })
            .map((control) => control.index);

          return {
            index,
            id: form.id || undefined,
            name: form.name || undefined,
            method: form.method || undefined,
            action: form.action ? new URL(form.action, document.baseURI).pathname : undefined,
            selectors: selectorsFor(form),
            controlIndexes: formControls,
          };
        });

      function sanitizeRenderedHtml(): string | undefined {
        if (!snapshotOptions.includeRenderedHtml) {
          return undefined;
        }

        const clone = document.documentElement.cloneNode(true) as HTMLElement;
        const sensitiveElements = clone.querySelectorAll('input, textarea, select, option');
        sensitiveElements.forEach((element) => {
          if (shouldRedact(element)) {
            element.setAttribute('value', '[REDACTED]');
            if (element instanceof HTMLTextAreaElement) {
              element.textContent = '[REDACTED]';
            }
            if (element instanceof HTMLSelectElement) {
              for (const option of Array.from(element.options)) {
                option.removeAttribute('selected');
              }
            }
          } else if (element.hasAttribute('value')) {
            element.setAttribute('value', safeValue(element, 'value', element.getAttribute('value') ?? ''));
          }
        });

        return clone.outerHTML.slice(0, limits.maxDomSnapshotChars);
      }

      return {
        title: document.title.slice(0, limits.maxControlTextChars),
        bodyText: (document.body?.innerText ?? '').slice(0, limits.maxDomSnapshotChars),
        forms,
        visibleControls,
        allControls: controls,
        renderedHtml: sanitizeRenderedHtml(),
      };
    },
    {
      limits: {
        maxControls: MAX_CONTROLS,
        maxForms: MAX_FORMS,
        maxAttrsPerElement: MAX_ATTRS_PER_ELEMENT,
        maxAttrValueChars: MAX_ATTR_VALUE_CHARS,
        maxControlTextChars: MAX_CONTROL_TEXT_CHARS,
        maxLabelContextChars: MAX_LABEL_CONTEXT_CHARS,
        maxDomSnapshotChars: options.maxDomSnapshotChars,
      },
      snapshotOptions: options,
    },
  );
}
