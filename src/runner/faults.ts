import { isAllowedResourceUrl } from '../security/validateTargetUrl.js';
import type { Decision, Policy, RequestInfo } from './routing.js';

/**
 * T7.2: controlled chaos. The `injectFault` step adds a rule to a FaultController; the controller's policy sits in the `faults` slot of the
 * routing layer (T5.1), so it runs after the allowlist guard and before the resource policy.
 *
 *  - Only requests to origins in ALLOWED_TARGET_ORIGINS / ALLOWED_RESOURCE_ORIGINS are touched. Anything else is left alone (and, with the
 *    guard on, was already aborted before this policy looked at it).
 *  - The first rule that matches answers. `times` counts the requests a rule answered; when it reaches zero the rule is gone.
 *  - Every request a rule answers is listed in the run's routing evidence with `handledBy: 'fault'`.
 *  - Pure apart from the allowlist check: no timers, no browser. The routing layer performs the delay.
 */

export const FAULT_HANDLED_BY = 'fault';

export type FaultAction =
  | { status: number; body?: string; contentType?: string }
  | { delayMs: number }
  | { abort: 'failed' | 'timedout' }
  | { malformedJson: true };

export interface FaultRule {
  match: { urlContains: string; method?: string };
  fault: FaultAction;
  times?: number;
  untilStep?: string;
}

/** A JSON document cut in the middle: it parses nowhere, and it looks like a connection that died while the server was writing. */
export const MALFORMED_JSON_BODY = '{"data":[{"id":1,"name":"';

interface ActiveRule extends FaultRule {
  remaining: number | undefined;
}

export interface FaultController {
  policy: Policy;
  add(rule: FaultRule): void;
  /** Removes the rules that were to last until this step. Call it when a step finishes. */
  stepFinished(stepId: string): void;
  /** Removes every rule (the teardown starts from an application that answers as it really does). */
  clear(): void;
  /** Rules still in force (for tests and the step's own message). */
  readonly size: number;
}

/** True when any step injects a fault. Pass the steps AFTER includes were expanded. */
export function usesFaults(request: { steps: readonly { action: string }[]; teardown?: readonly { action: string }[] }): boolean {
  return [...request.steps, ...(request.teardown ?? [])].some((step) => step.action === 'injectFault');
}

function ruleMatches(rule: FaultRule, request: RequestInfo): boolean {
  if (!request.url.includes(rule.match.urlContains)) return false;
  if (rule.match.method !== undefined && request.method.toUpperCase() !== rule.match.method.toUpperCase()) return false;
  return true;
}

function corsHeaders(request: RequestInfo): Record<string, string> {
  // A fetch from another allowed origin would reject a stand-in answer without these, and the page would see a CORS error instead of the 500.
  if (!request.initiatorOrigin) return {};
  let sameOrigin = false;
  try {
    sameOrigin = new URL(request.url).origin === request.initiatorOrigin;
  } catch {
    sameOrigin = false;
  }
  if (sameOrigin) return {};
  return { 'access-control-allow-origin': request.initiatorOrigin, 'access-control-allow-credentials': 'true', vary: 'Origin' };
}

function decisionFor(fault: FaultAction, request: RequestInfo): Decision {
  const handledBy = FAULT_HANDLED_BY;
  if ('status' in fault) {
    const body = fault.body;
    const contentType = fault.contentType ?? (body !== undefined && /^\s*[[{]/.test(body) ? 'application/json' : 'text/plain');
    return {
      action: 'fulfill',
      handledBy,
      status: fault.status,
      contentType,
      ...(body !== undefined ? { body } : {}),
      headers: corsHeaders(request),
      detail: `status ${fault.status}`,
    };
  }
  if ('delayMs' in fault) return { action: 'delay', handledBy, delayMs: fault.delayMs, detail: `delay ${fault.delayMs} ms` };
  if ('abort' in fault) return { action: 'abort', handledBy, errorCode: fault.abort, detail: `abort ${fault.abort}` };
  return {
    action: 'fulfill',
    handledBy,
    status: 200,
    contentType: 'application/json',
    body: MALFORMED_JSON_BODY,
    headers: corsHeaders(request),
    detail: 'malformed JSON',
  };
}

export function createFaultController(): FaultController {
  const rules: ActiveRule[] = [];

  const policy: Policy = (request) => {
    if (rules.length === 0) return undefined;
    // Faults only touch the application's own allowlisted origins.
    if (!isAllowedResourceUrl(request.url)) return undefined;
    const index = rules.findIndex((rule) => ruleMatches(rule, request));
    if (index < 0) return undefined;
    const rule = rules[index]!;
    if (rule.remaining !== undefined) {
      rule.remaining -= 1;
      if (rule.remaining <= 0) rules.splice(index, 1);
    }
    return decisionFor(rule.fault, request);
  };

  return {
    policy,
    add(rule) {
      rules.push({ ...rule, remaining: rule.times });
    },
    stepFinished(stepId) {
      for (let i = rules.length - 1; i >= 0; i -= 1) {
        if (rules[i]!.untilStep === stepId) rules.splice(i, 1);
      }
    },
    clear() {
      rules.length = 0;
    },
    get size() {
      return rules.length;
    },
  };
}
