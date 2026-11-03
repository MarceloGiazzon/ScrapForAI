import type { BrowserContext, Request, Route } from 'playwright';

import { isAllowedResourceUrl } from '../security/validateTargetUrl.js';

/**
 * T5.1: the ONE place a browser context intercepts requests. A single `context.route('**\/*')` composes policies in a fixed
 * order, so two features never fight over the same request:
 *
 *   1. allowlist guard   (BLOCK_UNEXPECTED_RESOURCES): a sub-resource from an origin outside the allowlists is aborted;
 *   2. fault injection   (T7.2, not built yet: pass policies in `faults`);
 *   3. resource policy   (T5.2, not built yet: pass policies in `resources`);
 *   4. otherwise the request continues untouched.
 *
 * With no active policy NOTHING is installed (no `context.route` at all), so a run behaves exactly as before. Every request a
 * policy touched is recorded with `handledBy`. A request ABORTED by policy is remembered so the evidence collector does not
 * count it as a network failure of the application: it was blocked on purpose.
 */

export interface RequestInfo {
  url: string;
  method: string;
  resourceType: string;
  /** A top-level or frame navigation. Navigations are checked by validateTargetUrl, not by the sub-resource guard. */
  isNavigation: boolean;
}

export type Decision =
  | { action: 'abort'; handledBy: string }
  | { action: 'fulfill'; handledBy: string; status: number; contentType?: string; body?: string | Buffer; headers?: Record<string, string> };

/** A policy answers for a request or returns undefined to let the next one look at it. */
export type Policy = (request: RequestInfo) => Decision | undefined;

export const ALLOWLIST_GUARD = 'allowlist-guard';

/** Aborts sub-resources whose origin is in neither ALLOWED_TARGET_ORIGINS nor ALLOWED_RESOURCE_ORIGINS. */
export const allowlistGuard: Policy = (request) => {
  if (request.isNavigation) return undefined;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(request.url)?.[1]?.toLowerCase();
  // data:, blob:, about: never leave the browser; only network schemes are an origin question.
  if (scheme !== 'http' && scheme !== 'https' && scheme !== 'ws' && scheme !== 'wss') return undefined;
  return isAllowedResourceUrl(request.url.replace(/^ws/i, 'http')) ? undefined : { action: 'abort', handledBy: ALLOWLIST_GUARD };
};

export interface PolicyOptions {
  blockUnexpected: boolean;
  /** T7.2 */
  faults?: Policy[];
  /** T5.2 */
  resources?: Policy[];
}

/** The policies in their fixed order. Empty = nothing to install. */
export function buildPolicies(options: PolicyOptions): Policy[] {
  return [...(options.blockUnexpected ? [allowlistGuard] : []), ...(options.faults ?? []), ...(options.resources ?? [])];
}

/** The first policy that answers wins; undefined means the request continues. */
export function decide(request: RequestInfo, policies: Policy[]): Decision | undefined {
  for (const policy of policies) {
    const decision = policy(request);
    if (decision) return decision;
  }
  return undefined;
}

export interface RoutingEvidence {
  origin: string;
  pathname: string;
  method: string;
  resourceType?: string;
  handledBy: string;
  action: 'abort' | 'fulfill';
}

export interface RoutingHandle {
  /** Requests a policy touched (capped). Empty when no policy is active. */
  entries: RoutingEvidence[];
  /** True for a request a policy aborted on purpose. */
  isAborted(request: Request): boolean;
  active: boolean;
}

const MAX_ENTRIES = 200;

function evidenceOf(request: RequestInfo, decision: Decision): RoutingEvidence {
  let origin = 'unknown';
  let pathname = '/';
  try {
    const parsed = new URL(request.url);
    origin = parsed.origin;
    pathname = parsed.pathname;
  } catch {
    pathname = 'invalid-url';
  }
  return { origin, pathname, method: request.method, resourceType: request.resourceType, handledBy: decision.handledBy, action: decision.action };
}

export async function installRouting(context: Pick<BrowserContext, 'route'>, policies: Policy[]): Promise<RoutingHandle> {
  const entries: RoutingEvidence[] = [];
  const aborted = new WeakSet<Request>();

  if (policies.length === 0) {
    return { entries, isAborted: () => false, active: false };
  }

  await context.route('**/*', async (route: Route) => {
    const request = route.request();
    const info: RequestInfo = {
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      isNavigation: request.isNavigationRequest(),
    };

    let decision: Decision | undefined;
    try {
      decision = decide(info, policies);
    } catch {
      // A broken policy must not stall the page: fail open for that request, like having no policy.
      decision = undefined;
    }

    try {
      if (!decision) {
        await route.continue();
        return;
      }
      if (entries.length < MAX_ENTRIES) entries.push(evidenceOf(info, decision));
      if (decision.action === 'abort') {
        aborted.add(request);
        await route.abort('blockedbyclient');
      } else {
        await route.fulfill({
          status: decision.status,
          ...(decision.contentType ? { contentType: decision.contentType } : {}),
          ...(decision.headers ? { headers: decision.headers } : {}),
          ...(decision.body !== undefined ? { body: decision.body } : {}),
        });
      }
    } catch {
      // The page or context closed while the request was in flight.
    }
  });

  return { entries, isAborted: (request) => aborted.has(request), active: true };
}
