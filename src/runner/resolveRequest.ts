import { expandIncludes, type IncludedRoutineRef } from '../library/includeExpander.js';
import type { ExplorationRequest, ExplorationStep, RunnableStep } from '../schemas/explorationRequest.schema.js';
import { RequestResolutionError } from './resolutionError.js';
import type { CredentialBinding } from '../security/credentialBinding.js';
import { getTarget } from '../targets/targetStore.js';
import { resolveCredentialSet } from '../vault/credentials/credentialVault.js';
import { validateTargetUrl } from '../security/validateTargetUrl.js';

export { RequestResolutionError };

/** A request whose target profile and credential set have been resolved server-side. */
export type ResolvedExplorationRequest = Omit<ExplorationRequest, 'steps' | 'teardown'> & {
  targetUrl: string;
  /** Includes are expanded (T1.4): the runner only sees executable steps. */
  steps: RunnableStep[];
  teardown?: RunnableStep[];
  /** The routines expanded into this run, with the versions actually used. */
  includes?: IncludedRoutineRef[];
  /** The request as written (include steps intact), kept so a good run can be saved as a routine. */
  unexpanded?: { steps: ExplorationStep[]; teardown?: ExplorationStep[] };
  /** Set only when `credentialSet` was used; drives the per-fill origin check. */
  credentialBinding?: CredentialBinding;
  /** Set when the run executes a library routine (T1.3); recorded in the result and history. */
  routine?: { id: string; version: number; sha256: string };
  /** Set when the run is one variant of a suite (T1.6); recorded in the result and history. */
  suite?: { suiteRunId: string; variantKey: string };
};

/**
 * Fills in what the caller deliberately does not control:
 *  - `targetProfile` -> default `targetUrl` (the profile cannot widen the allowlist; baseUrl is
 *    re-validated here, and every navigation is re-validated again by the runner);
 *  - `credentialSet` -> `credentials`, loaded from the vault. Vault values WIN over inline ones of
 *    the same name, so a caller can never shadow a vaulted secret.
 */
export async function resolveExplorationRequest(
  request: ExplorationRequest,
  options: { includeProfile?: string } = {},
): Promise<ResolvedExplorationRequest> {
  let targetUrl = request.targetUrl;
  let allowedSets: string[] | undefined;

  if (request.targetProfile !== undefined) {
    const profile = await getTarget(request.targetProfile);
    if (!profile) {
      throw new RequestResolutionError(404, 'TargetProfileNotFound', `Target profile "${request.targetProfile}" does not exist`);
    }

    targetUrl ??= validateTargetUrl(profile.baseUrl);
    allowedSets = profile.credentialSets;
  }

  if (targetUrl === undefined) {
    throw new RequestResolutionError(400, 'ValidationError', 'targetUrl is required unless targetProfile is given');
  }

  const expanded = await expandIncludes(
    { steps: request.steps, teardown: request.teardown },
    // The includes must belong to the app the routine was written for, even when a suite runs it against
    // another environment's profile (qa instead of dev).
    { targetProfile: options.includeProfile ?? request.targetProfile },
  );
  const { steps: _steps, teardown: _teardown, ...rest } = request;
  const resolved: ResolvedExplorationRequest = {
    ...rest,
    targetUrl,
    steps: expanded.steps,
    ...(expanded.teardown.length > 0 ? { teardown: expanded.teardown } : {}),
    ...(expanded.includes.length > 0
      ? { includes: expanded.includes, unexpanded: { steps: request.steps, ...(request.teardown ? { teardown: request.teardown } : {}) } }
      : {}),
  };

  if (request.credentialSet !== undefined) {
    if (allowedSets && !allowedSets.includes(request.credentialSet)) {
      throw new RequestResolutionError(
        403,
        'CredentialSetNotAllowed',
        `Credential set "${request.credentialSet}" is not allowed for target profile "${request.targetProfile}"`,
      );
    }

    const set = await resolveCredentialSet(request.credentialSet);
    if (!set) {
      throw new RequestResolutionError(404, 'CredentialSetNotFound', `Credential set "${request.credentialSet}" does not exist`);
    }

    resolved.credentials = { ...request.credentials, ...set.values };
    resolved.credentialBinding = { setId: set.id, boundOrigins: set.boundOrigins, fields: Object.keys(set.values) };
  }

  return resolved;
}
