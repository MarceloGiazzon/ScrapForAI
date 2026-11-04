import type { Frame } from 'playwright';

import type { JsonValue } from '../../schemas/explorationResult.schema.js';
import { redactSecrets } from '../../security/redactSecrets.js';
import { getTrustedScript, type TrustedScriptDefinition, type TrustedScriptId, verifyTrustedScripts } from './registry.js';

/** T7.1: runs one registered script in a frame. The caller supplies an id and JSON data, never code. */

export class TrustedScriptError extends Error {
  constructor(
    readonly scriptId: string,
    message: string,
  ) {
    super(`Trusted script "${scriptId}": ${message}`);
    this.name = 'TrustedScriptError';
  }
}

let verified = false;

/** The registry is checked once per process on first use (the server also checks it at boot, which is what stops a bad build from starting). */
function ensureVerified(): void {
  if (!verified) {
    verifyTrustedScripts();
    verified = true;
  }
}

/** For tests only: forget the cached verification. */
export function resetTrustedVerification(): void {
  verified = false;
}

export interface TrustedRunOptions {
  /** Values to mask in the output (vault secrets of the run). */
  knownSecrets?: string[];
  /** Replaces the registry lookup (tests). */
  definition?: TrustedScriptDefinition;
}

/**
 * `args` is serialized with JSON.stringify and sent as a literal next to the fixed source, so it can only ever be data. The result is redacted and
 * must fit the script's `maxOutputChars`: an oversized answer is an error, not a silent cut.
 */
export async function runTrustedScript(frame: Frame, id: TrustedScriptId, args: Record<string, JsonValue> = {}, options: TrustedRunOptions = {}): Promise<JsonValue> {
  const definition = options.definition ?? (ensureVerified(), getTrustedScript(id));
  const expression = `(${definition.source})(${JSON.stringify(args)})`;

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TrustedScriptError(definition.id, `did not answer within ${definition.timeoutMs} ms`)), definition.timeoutMs);
  });

  let raw: unknown;
  try {
    raw = await Promise.race([frame.evaluate(expression), timeout]);
  } catch (error) {
    if (error instanceof TrustedScriptError) throw error;
    throw new TrustedScriptError(definition.id, error instanceof Error ? error.message.split('\n')[0]! : 'failed');
  } finally {
    if (timer) clearTimeout(timer);
  }

  const redacted = redactSecrets(raw ?? null, options.knownSecrets ?? []) as JsonValue;
  const size = JSON.stringify(redacted).length;
  if (size > definition.maxOutputChars) {
    throw new TrustedScriptError(definition.id, `answer is ${size} characters, over its limit of ${definition.maxOutputChars}`);
  }
  return redacted;
}
