import { createHash } from 'node:crypto';

import { docHighlightSource } from './scripts/doc.js';
import { axeAuditSource } from './scripts/axe.js';
import { netStateSource, netTrackerSource } from './scripts/network.js';
import { piiSurfacesSource } from './scripts/pii.js';
import { keyboardActiveSource, keyboardCandidatesSource, keyboardStyleSource } from './scripts/keyboard.js';

/**
 * T7.1: the scripts that belong to THIS project and run inside the page of a target. They are a closed list: a step names an `id`, the server looks
 * the source up here and sends it; the caller never sends code. That is why they do not go through ALLOW_EVALUATE, which stays for code that comes
 * from the caller (`evaluate`/`watch`).
 *
 * Every source is pinned by its sha256. `verifyTrustedScripts()` runs when the server boots and before the first use: a source that no longer
 * matches (edited, or the pin forgotten) makes the server REFUSE TO START, so a change to what runs in the page is always a reviewed change of this
 * file. To change a script on purpose: edit it, run `npx tsx scripts/trusted-hashes.ts`, paste the new hash here.
 *
 * What this protects: against an unreviewed change of a source. It does not protect against someone who can edit both the source and this file.
 */

export interface TrustedScriptDefinition {
  id: string;
  /** A JavaScript expression that evaluates to a function; it is called with the JSON `args`. */
  source: string;
  /** sha256 of `source` (UTF-8, hex). */
  sha256: string;
  /** The script is abandoned (the step fails) after this long. */
  timeoutMs: number;
  /** A result longer than this (as JSON) is refused, never truncated silently. */
  maxOutputChars: number;
}

export class TrustedScriptIntegrityError extends Error {
  constructor(
    readonly scriptId: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`Trusted script "${scriptId}" does not match its pinned sha256 (pinned ${expected.slice(0, 12)}..., source is ${actual.slice(0, 12)}...). Review the change, then pin the new hash in src/runner/trusted/registry.ts.`);
    this.name = 'TrustedScriptIntegrityError';
  }
}

export const sha256Of = (source: string): string => createHash('sha256').update(source, 'utf8').digest('hex');

export const TRUSTED_SCRIPTS = [
  { id: 'keyboard-active', source: keyboardActiveSource, sha256: '643f7b6861fc4d42351463a014380c9f5331f028a32ea1969cfc45eb976dbd6b', timeoutMs: 3000, maxOutputChars: 4000 },
  { id: 'keyboard-style', source: keyboardStyleSource, sha256: '90bf8d9ed0884cd6d47c96e1e9fa1ea94202d0a9f26a515c1c7e946cad2fb376', timeoutMs: 3000, maxOutputChars: 4000 },
  { id: 'keyboard-candidates', source: keyboardCandidatesSource, sha256: '50f6c6984a475566d45ba19226a8b7c48239e430a7dd3dce89c8caa0b01e2433', timeoutMs: 5000, maxOutputChars: 150_000 },
  // T7.4: axe-core (MPL-2.0, unmodified, read from node_modules) plus our runner. This hash moves with the axe-core version ON PURPOSE: review, then pin.
  { id: 'a11y-axe', source: axeAuditSource, sha256: 'b48ec2d85edd794c0258305adebf0566dc2d9c0227745c7ec1df6a200463c807', timeoutMs: 30_000, maxOutputChars: 250_000 },
  // T7.8: reads localStorage/sessionStorage and hidden inputs for the PII hunt; the server scans the text and keeps none of it.
  { id: 'pii-surfaces', source: piiSurfacesSource, sha256: 'f4723e225ca9d8c24165c375a521a730a7f3a5fdb9e5a4ead00778d6b15c635f', timeoutMs: 5000, maxOutputChars: 1_000_000 },
  // T8.2: counts pending XHR/fetch (installed as an init script) and reads the count; two numbers, no URL or body.
  { id: 'net-tracker', source: netTrackerSource, sha256: 'ad6127ef1fd3759676cf146e4d4fb7c47012a74000dab4150acbbc3e7b0350d3', timeoutMs: 3000, maxOutputChars: 100 },
  { id: 'net-state', source: netStateSource, sha256: '6bca5fa4164712483465e3a0a39277eefc848033526cad83795af59dbe824305', timeoutMs: 1000, maxOutputChars: 100 },
  // T9.2: draws / removes the highlight border of a documentation figure around rectangles the server computed. Takes numbers only.
  { id: 'doc-highlight', source: docHighlightSource, sha256: '8c88cbbe58f8ac67fa8eaf34e3208eb0b03de7d9a339734699c3a1be1c1ae537', timeoutMs: 3000, maxOutputChars: 200 },
] as const satisfies readonly TrustedScriptDefinition[];

export type TrustedScriptId = (typeof TRUSTED_SCRIPTS)[number]['id'];

/** Throws at the first script whose source does not match its pin (and on a duplicated id). */
export function verifyTrustedScripts(definitions: readonly TrustedScriptDefinition[] = TRUSTED_SCRIPTS): void {
  const seen = new Set<string>();
  for (const definition of definitions) {
    if (seen.has(definition.id)) throw new Error(`Trusted script id "${definition.id}" is registered twice`);
    seen.add(definition.id);
    const actual = sha256Of(definition.source);
    if (actual !== definition.sha256) throw new TrustedScriptIntegrityError(definition.id, definition.sha256, actual);
  }
}

export function getTrustedScript(id: TrustedScriptId): TrustedScriptDefinition {
  return TRUSTED_SCRIPTS.find((script) => script.id === id)!;
}
