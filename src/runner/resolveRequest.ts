import { ParameterError, resolveParameters } from '../generators/resolveParameters.js';
import { expandIncludes, type IncludedRoutineRef } from '../library/includeExpander.js';
import type { ExplorationRequest, ExplorationStep, RunnableStep } from '../schemas/explorationRequest.schema.js';
import type { ParameterRecord } from '../schemas/parameters.schema.js';
import type { BuildInfo } from './buildProbe.js';
import { usesFaults } from './faults.js';
import { RequestResolutionError } from './resolutionError.js';
import type { CredentialBinding } from '../security/credentialBinding.js';
import { getTarget } from '../targets/targetStore.js';
import { resolveCredentialSet } from '../vault/credentials/credentialVault.js';
import { validateTargetUrl } from '../security/validateTargetUrl.js';

export { RequestResolutionError };

/** Id of the include the profile's login gets (T8.1); its steps become `autologin.<stepId>`. */
export const AUTO_LOGIN_ID = 'autologin';

/** True when a step types a vault value: the run logs itself in. */
function typesCredential(steps: RunnableStep[]): boolean {
  return steps.some((step) => (step.action === 'fill' || step.action === 'selectOption') && step.valueFromCredential !== undefined);
}

/** A request whose target profile and credential set have been resolved server-side. */
export type ResolvedExplorationRequest = Omit<ExplorationRequest, 'steps' | 'teardown'> & {
  targetUrl: string;
  /** Includes are expanded (T1.4): the runner only sees executable steps. */
  steps: RunnableStep[];
  teardown?: RunnableStep[];
  /** The routines expanded into this run, with the versions actually used. */
  includes?: IncludedRoutineRef[];
  /** T5.3: the values the run's parameters take for its seed and sample. Absent when the run uses no parameter. */
  parameterRecord?: ParameterRecord;
  /** The request as written (include steps intact), kept so a good run can be saved as a routine. */
  unexpanded?: { steps: ExplorationStep[]; teardown?: ExplorationStep[] };
  /** Set only when `credentialSet` was used; drives the per-fill origin check. */
  credentialBinding?: CredentialBinding;
  /** Set when the run executes a library routine (T1.3); recorded in the result and history. */
  routine?: { id: string; version: number; sha256: string };
  /** Set when the run is one variant of a suite (T1.6); recorded in the result and history. */
  suite?: { suiteRunId: string; variantKey: string };
  /** T8.1: the profile's login routine was included before the steps (platform genexus). `gate` = the profile's login gate follows it. */
  autoLogin?: { routineId: string; version: number; gate: boolean };
  /** T3.1: where the profile says the build id lives; probed after the run when the caller gave no `buildId`. */
  buildProbe?: { info: BuildInfo; baseUrl: string };
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
  let buildProbe: ResolvedExplorationRequest['buildProbe'];
  let faultsForbiddenBy: string | undefined;
  let autoLoginSource: { routineId: string; gate?: { urlContains: string; timeoutMs: number } } | undefined;

  if (request.targetProfile !== undefined) {
    const profile = await getTarget(request.targetProfile);
    if (!profile) {
      throw new RequestResolutionError(404, 'TargetProfileNotFound', `Target profile "${request.targetProfile}" does not exist`);
    }

    targetUrl ??= validateTargetUrl(profile.baseUrl);
    allowedSets = profile.credentialSets;
    faultsForbiddenBy = profile.environment === 'staging' && !profile.flags.allowFaults ? profile.id : undefined;
    // T8.1: a genexus profile logs in for you when the run uses one of its credential sets (platform npdev: rules still to be gathered with that team).
    if (profile.platform === 'genexus' && profile.loginRoutine && request.credentialSet !== undefined && request.options.autoLogin !== false) {
      autoLoginSource = { routineId: profile.loginRoutine, ...(profile.loginGate ? { gate: profile.loginGate } : {}) };
    }
    // The caller's own buildId wins; "provided" means the profile expects the caller to say it, so nothing to probe.
    if (profile.buildInfo && profile.buildInfo.kind !== 'provided' && request.buildId === undefined) {
      buildProbe = { info: profile.buildInfo, baseUrl: profile.baseUrl };
    }
  }

  if (targetUrl === undefined) {
    throw new RequestResolutionError(400, 'ValidationError', 'targetUrl is required unless targetProfile is given');
  }

  // The includes must belong to the app the routine was written for, even when a suite runs it against
  // another environment's profile (qa instead of dev).
  const expandOptions = { targetProfile: options.includeProfile ?? request.targetProfile };
  const expandInput = { steps: request.steps, teardown: request.teardown, ...(request.parameters ? { parameters: request.parameters } : {}) };
  let expanded = await expandIncludes(expandInput, expandOptions);
  let autoLogin: ResolvedExplorationRequest['autoLogin'];

  // A request that already types a credential logs in by itself (an explicit include of the login, the login routine run on its own, a permission
  // matrix, a snapshot): the profile's login would be a second session, which GeneXus answers by ending the first. So it is added only to a run that does not.
  if (autoLoginSource && !typesCredential(expanded.steps)) {
    const loginSteps: ExplorationStep[] = [
      { id: AUTO_LOGIN_ID, action: 'include', routineId: autoLoginSource.routineId },
      ...(autoLoginSource.gate
        ? ([{ id: `${AUTO_LOGIN_ID}-gate`, action: 'waitForUrlContains', value: autoLoginSource.gate.urlContains, timeoutMs: autoLoginSource.gate.timeoutMs }] as ExplorationStep[])
        : []),
    ];
    expanded = await expandIncludes({ ...expandInput, steps: [...loginSteps, ...request.steps] }, expandOptions);
    const used = expanded.includes.find((ref) => ref.routineId === autoLoginSource!.routineId);
    if (used) autoLogin = { routineId: used.routineId, version: used.version, gate: autoLoginSource.gate !== undefined };
  }
  // T7.2: a staging environment is shared; breaking its answers on purpose is a decision of the profile, not of one routine (also through an include).
  if (faultsForbiddenBy !== undefined && usesFaults(expanded)) {
    throw new RequestResolutionError(
      403,
      'FaultsNotAllowed',
      `Target profile "${faultsForbiddenBy}" is a staging environment and does not set flags.allowFaults; injectFault is refused`,
    );
  }
  // T5.3: parameters and inline generators become concrete values (the seed is returned, so a run can be replayed).
  let parameterized: ReturnType<typeof resolveParameters<RunnableStep>>;
  try {
    parameterized = resolveParameters<RunnableStep>({
      steps: expanded.steps,
      ...(expanded.teardown.length > 0 ? { teardown: expanded.teardown } : {}),
      ...(request.parameters || expanded.parameters.length > 0 ? { parameters: [...(request.parameters ?? []), ...expanded.parameters] } : {}),
      ...(request.seed ? { seed: request.seed } : {}),
      ...(request.sample === undefined ? {} : { sample: request.sample }),
      ...(request.parameterValues ? { fixed: request.parameterValues } : {}),
    });
  } catch (error) {
    if (error instanceof ParameterError) throw new RequestResolutionError(400, error.type, error.message);
    throw error;
  }

  const { steps: _steps, teardown: _teardown, ...rest } = request;
  const resolved: ResolvedExplorationRequest = {
    ...rest,
    targetUrl,
    steps: parameterized.steps,
    ...(buildProbe ? { buildProbe } : {}),
    ...(autoLogin ? { autoLogin } : {}),
    ...(parameterized.teardown && parameterized.teardown.length > 0 ? { teardown: parameterized.teardown } : {}),
    ...(parameterized.record ? { parameterRecord: parameterized.record } : {}),
    // Kept "as written" whenever the steps were rewritten (includes expanded, inline generators turned into parameters), so a good
    // run saves as the routine its author wrote, not as the expansion.
    ...(expanded.includes.length > 0 || parameterized.record
      ? {
          ...(expanded.includes.length > 0 ? { includes: expanded.includes } : {}),
          unexpanded: { steps: request.steps, ...(request.teardown ? { teardown: request.teardown } : {}) },
        }
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
