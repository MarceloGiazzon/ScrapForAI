import { env } from '../config/env.js';
import { ParameterError, resolveParameters } from '../generators/resolveParameters.js';
import { expandIncludes, type IncludedRoutineRef } from '../library/includeExpander.js';
import type { ExplorationRequest, ExplorationStep, RunnableLeaf, RunnableStep } from '../schemas/explorationRequest.schema.js';
import type { ParameterRecord } from '../schemas/parameters.schema.js';
import { DEFAULT_HTTP_METHODS, type HttpMethod } from '../schemas/httpMethods.js';
import { someStep } from '../schemas/stepTree.js';
import { resolveTables, type TableUse } from '../tables/resolveTables.js';
import type { BuildInfo } from './buildProbe.js';
import { usesFaults } from './faults.js';
import { RequestResolutionError } from './resolutionError.js';
import { firstOverflow } from '../orchestrator/jobQueue.js';
import type { Initiator } from '../team/initiator.js';
import { actorsInUse, sessionCredentialSets } from './actors.js';
import type { CredentialBinding } from '../security/credentialBinding.js';
import { getTarget } from '../targets/targetStore.js';
import { resolveCredentialSet } from '../vault/credentials/credentialVault.js';
import { validateTargetUrl } from '../security/validateTargetUrl.js';

export { RequestResolutionError };

/** Id of the include the profile's login gets (T8.1); its steps become `autologin.<stepId>`. */
export const AUTO_LOGIN_ID = 'autologin';

/** T5.7: the methods of every httpRequest in the (expanded) steps and teardown, branches included. */
function httpMethodsUsed(request: { steps: readonly object[]; teardown?: readonly object[] }): string[] {
  const methods: string[] = [];
  someStep([...request.steps, ...(request.teardown ?? [])], (step) => {
    const candidate = step as { action: string; method?: string };
    if (candidate.action === 'httpRequest' && candidate.method) methods.push(candidate.method.toUpperCase());
    return false;
  });
  return methods;
}

/** True when a step types a vault value: the run logs itself in. */
function typesCredential(steps: RunnableStep[]): boolean {
  return someStep(steps, (step) => (step.action === 'fill' || step.action === 'selectOption') && step.valueFromCredential !== undefined);
}

/** T6.4: what one actor may type from the vault: the fields of ITS credential set, and the origins they are bound to. */
export interface ActorCredentials {
  credentials: Record<string, string>;
  credentialBinding: CredentialBinding;
}

/** A request whose target profile and credential set have been resolved server-side. */
export type ResolvedExplorationRequest = Omit<ExplorationRequest, 'steps' | 'teardown'> & {
  targetUrl: string;
  /** Includes are expanded (T1.4): the runner only sees executable steps. */
  steps: RunnableStep[];
  /** A teardown holds no `parallel` block (T6.5): its steps run one after the other. */
  teardown?: RunnableLeaf[];
  /** The routines expanded into this run, with the versions actually used. */
  includes?: IncludedRoutineRef[];
  /** T5.3: the values the run's parameters take for its seed and sample. Absent when the run uses no parameter. */
  parameterRecord?: ParameterRecord;
  /** T5.5: the version of every table of cases the run read (the current one when the reference named none), recorded in the result. */
  tables?: TableUse[];
  /** The request as written (include steps intact), kept so a good run can be saved as a routine. */
  unexpanded?: { steps: ExplorationStep[]; teardown?: ExplorationStep[] };
  /** Set only when `credentialSet` was used; drives the per-fill origin check. */
  credentialBinding?: CredentialBinding;
  /**
   * T6.4: the vault values of each declared actor that has a `credentialSet`, keyed by actor. `credentials`/`credentialBinding` above belong to
   * `main` only: an actor never sees another actor's values, and an actor with no set here has none.
   */
  actorCredentials?: Record<string, ActorCredentials>;
  /** Set when the run executes a library routine (T1.3); recorded in the result and history. */
  routine?: { id: string; version: number; sha256: string };
  /** Set when the run is one variant of a suite (T1.6); recorded in the result and history. */
  suite?: { suiteRunId: string; variantKey: string };
  /** T8.1: the profile's login routine was included before the steps (platform genexus). `gate` = the profile's login gate follows it. */
  autoLogin?: { routineId: string; version: number; gate: boolean };
  /** T3.1: where the profile says the build id lives; probed after the run when the caller gave no `buildId`. */
  buildProbe?: { info: BuildInfo; baseUrl: string };
  /** T5.7: the methods an `httpRequest` step may use (the target profile's `http.allowedMethods`; absent = GET and HEAD). */
  httpMethods?: HttpMethod[];
};

/**
 * Fills in what the caller deliberately does not control:
 *  - `targetProfile` -> default `targetUrl` (the profile cannot widen the allowlist; baseUrl is
 *    re-validated here, and every navigation is re-validated again by the runner);
 *  - `credentialSet` -> `credentials`, loaded from the vault. Vault values WIN over inline ones of
 *    the same name, so a caller can never shadow a vaulted secret.
 *
 * `initiator` is who the run is for and is REQUIRED (not defaulted): a credential set can be restricted to some users, and this is the one
 * place every run loads its sets (the run's own and each actor's), so a caller that forgot to say who is asking could not compile.
 */
export async function resolveExplorationRequest(
  request: ExplorationRequest,
  options: { includeProfile?: string; initiator: Initiator },
): Promise<ResolvedExplorationRequest> {
  let targetUrl = request.targetUrl;
  let allowedSets: string[] | undefined;
  let buildProbe: ResolvedExplorationRequest['buildProbe'];
  let faultsForbiddenBy: string | undefined;
  let httpMethods: HttpMethod[] | undefined;
  let maxSessionsPerCredential = 1;
  let autoLoginSource: { routineId: string; gate?: { urlContains: string; timeoutMs: number } } | undefined;

  if (request.targetProfile !== undefined) {
    const profile = await getTarget(request.targetProfile);
    if (!profile) {
      throw new RequestResolutionError(404, 'TargetProfileNotFound', `Target profile "${request.targetProfile}" does not exist`);
    }

    targetUrl ??= validateTargetUrl(profile.baseUrl);
    allowedSets = profile.credentialSets;
    maxSessionsPerCredential = profile.flags.maxSessionsPerCredential ?? 1;
    faultsForbiddenBy = profile.environment === 'staging' && !profile.flags.allowFaults ? profile.id : undefined;
    httpMethods = profile.http?.allowedMethods;
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
  const expandInput = {
    steps: request.steps,
    teardown: request.teardown,
    ...(request.parameters ? { parameters: request.parameters } : {}),
    ...(request.actors ? { actors: request.actors } : {}),
  };
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
  // T5.7: an httpRequest may only use the methods the profile lists (default GET/HEAD); checked after the includes are expanded, before any browser starts.
  const allowedHttp: readonly string[] = httpMethods ?? DEFAULT_HTTP_METHODS;
  const refused = httpMethodsUsed(expanded).filter((method) => !allowedHttp.includes(method));
  if (refused.length > 0) {
    throw new RequestResolutionError(
      403,
      'HttpMethodNotAllowed',
      `httpRequest uses ${[...new Set(refused)].join(', ')}, which ${request.targetProfile ? `target profile "${request.targetProfile}" does not allow` : 'a run without a target profile does not allow'} (allowed: ${allowedHttp.join(', ')}); list the methods in the profile's http.allowedMethods`,
    );
  }
  // T5.5: a column of a stored table of cases becomes the `cases` of a parameter, and an expected cell the literal of the run's row.
  const tabled = await resolveTables<RunnableStep>({
    steps: expanded.steps,
    ...(expanded.teardown.length > 0 ? { teardown: expanded.teardown } : {}),
    ...(request.parameters || expanded.parameters.length > 0 ? { parameters: [...(request.parameters ?? []), ...expanded.parameters] } : {}),
    ...(request.sample === undefined ? {} : { sample: request.sample }),
    ...(request.parameterValues ? { hasFixedValues: true } : {}),
  });
  // T5.3: parameters and inline generators become concrete values (the seed is returned, so a run can be replayed).
  let parameterized: ReturnType<typeof resolveParameters<RunnableStep>>;
  try {
    parameterized = resolveParameters<RunnableStep>({
      steps: tabled.steps,
      ...(tabled.teardown && tabled.teardown.length > 0 ? { teardown: tabled.teardown } : {}),
      ...(tabled.parameters ? { parameters: tabled.parameters } : {}),
      ...(request.seed ? { seed: request.seed } : {}),
      ...(request.sample === undefined ? {} : { sample: request.sample }),
      ...(request.parameterValues ? { fixed: request.parameterValues } : {}),
    });
  } catch (error) {
    if (error instanceof ParameterError) throw new RequestResolutionError(400, error.type, error.message);
    throw error;
  }

  // T6.4: every actor in use is a real browser context and a real session; and an account can be in only as many sessions as the profile allows.
  const used = actorsInUse(parameterized);
  if (used.length > env.MAX_ACTORS_PER_JOB) {
    throw new RequestResolutionError(400, 'TooManyActors', `The run uses ${used.length} actors (${used.join(', ')}) but MAX_ACTORS_PER_JOB is ${env.MAX_ACTORS_PER_JOB}`);
  }
  const overflow = firstOverflow(sessionCredentialSets(request), maxSessionsPerCredential);
  if (overflow) {
    throw new RequestResolutionError(
      400,
      'TooManySessionsForCredential',
      `Credential set "${overflow.lockKey}" is used by ${overflow.wanted} actors of this run but the target profile allows ${maxSessionsPerCredential} simultaneous session(s) (flags.maxSessionsPerCredential)`,
    );
  }

  const { steps: _steps, teardown: _teardown, ...rest } = request;
  const resolved: ResolvedExplorationRequest = {
    ...rest,
    targetUrl,
    steps: parameterized.steps,
    ...(buildProbe ? { buildProbe } : {}),
    ...(httpMethods ? { httpMethods } : {}),
    ...(autoLogin ? { autoLogin } : {}),
    // The schema keeps `parallel` out of a teardown (and the expander re-checks the expanded list), so these are all leaf steps.
    ...(parameterized.teardown && parameterized.teardown.length > 0 ? { teardown: parameterized.teardown as RunnableLeaf[] } : {}),
    ...(parameterized.record ? { parameterRecord: parameterized.record } : {}),
    ...(tabled.tables ? { tables: tabled.tables } : {}),
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

    const set = await resolveCredentialSet(request.credentialSet, options.initiator);
    if (!set) {
      throw new RequestResolutionError(404, 'CredentialSetNotFound', `Credential set "${request.credentialSet}" does not exist`);
    }

    resolved.credentials = { ...request.credentials, ...set.values };
    resolved.credentialBinding = { setId: set.id, boundOrigins: set.boundOrigins, fields: Object.keys(set.values) };
  }

  // T6.4: each actor loads ITS OWN set, under the same rules as the run's. No fallback to main's: an actor without a set has no vault values.
  for (const [actorName, actor] of Object.entries(request.actors ?? {})) {
    if (actor.credentialSet === undefined) continue;
    if (allowedSets && !allowedSets.includes(actor.credentialSet)) {
      throw new RequestResolutionError(
        403,
        'CredentialSetNotAllowed',
        `Credential set "${actor.credentialSet}" (actor "${actorName}") is not allowed for target profile "${request.targetProfile}"`,
      );
    }
    const set = await resolveCredentialSet(actor.credentialSet, options.initiator);
    if (!set) {
      throw new RequestResolutionError(404, 'CredentialSetNotFound', `Credential set "${actor.credentialSet}" (actor "${actorName}") does not exist`);
    }
    (resolved.actorCredentials ??= {})[actorName] = {
      credentials: { ...set.values },
      credentialBinding: { setId: set.id, boundOrigins: set.boundOrigins, fields: Object.keys(set.values) },
    };
  }

  return resolved;
}
