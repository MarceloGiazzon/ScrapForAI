import { getLiveAllowedOrigins } from '../config/env.js';
import { RequestResolutionError } from '../runner/resolutionError.js';
import { type Integration, integrationWriteSchema } from '../schemas/integration.schema.js';
import { getTarget } from '../targets/targetStore.js';
import { checkGithubAccess } from './githubIssues.js';
import { assertIntegrationUrl, IntegrationOriginError } from './integrationPolicy.js';
import { deleteIntegration, getIntegration, integrationTokenOrigin, listIntegrations, putIntegration, resolveIntegrationToken, saveIntegrationToken, type StoredIntegration } from './integrationStore.js';

export class IntegrationError extends RequestResolutionError {}

/** What a read returns. NEVER the token: only whether there is one and the origin it is bound to. */
export interface IntegrationView {
  integration: Integration;
  createdAt: string;
  updatedAt: string;
  hasToken: boolean;
  apiOrigin: string;
  /** The API origin is (still) in ALLOWED_INTEGRATION_ORIGINS. When false, nothing is sent. */
  originAllowed: boolean;
}

function originOf(apiBaseUrl: string): string {
  try {
    return new URL(apiBaseUrl).origin;
  } catch {
    return apiBaseUrl;
  }
}

async function view(stored: StoredIntegration): Promise<IntegrationView> {
  const { integration } = stored;
  const apiOrigin = originOf(integration.apiBaseUrl);
  return {
    integration,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    hasToken: (await integrationTokenOrigin(integration.id)) !== undefined,
    apiOrigin,
    originAllowed: getLiveAllowedOrigins('ALLOWED_INTEGRATION_ORIGINS').includes(apiOrigin),
  };
}

export async function listIntegrationViews(): Promise<IntegrationView[]> {
  return Promise.all((await listIntegrations()).map(view));
}

export async function getIntegrationView(id: string): Promise<IntegrationView | undefined> {
  const stored = await getIntegration(id);
  return stored ? view(stored) : undefined;
}

/** Validates, stores the token in the credential vault and the rest as the definition. An address outside ALLOWED_INTEGRATION_ORIGINS is refused here, not at 03:00. */
export async function saveIntegrationDefinition(id: string, body: unknown, nowMs = Date.now()): Promise<{ view: IntegrationView; created: boolean }> {
  const { token, ...rest } = integrationWriteSchema.parse(body);
  const integration: Integration = { id, ...rest };

  let base: URL;
  try {
    base = assertIntegrationUrl(integration.apiBaseUrl);
  } catch (error) {
    if (error instanceof IntegrationOriginError) throw new IntegrationError(400, error.name, error.message);
    throw error;
  }

  for (const profile of integration.targetProfiles) {
    if (!(await getTarget(profile).catch(() => undefined))) throw new IntegrationError(404, 'TargetNotFound', `Target profile "${profile}" does not exist`);
  }

  if (token === undefined) {
    const bound = await integrationTokenOrigin(id);
    if (bound === undefined) throw new IntegrationError(400, 'IntegrationTokenRequired', 'token is required when creating an integration');
    // A stored token must never silently start going to another host.
    if (bound !== base.origin) throw new IntegrationError(400, 'IntegrationTokenRequired', 'The API address changed to another origin: send the token again (it is bound to the origin it was stored for)');
  } else {
    await saveIntegrationToken(id, token, base.origin);
  }

  const { stored, created } = await putIntegration(integration, new Date(nowMs).toISOString());
  return { view: await view(stored), created };
}

export async function removeIntegration(id: string): Promise<boolean> {
  return deleteIntegration(id);
}

export interface IntegrationCheck {
  ok: boolean;
  reason?: string;
  httpStatus?: number;
  issuesEnabled?: boolean;
}

/** POST /v1/integrations/:id/test: can the stored token see the repository? Creates nothing. */
export async function testIntegration(id: string): Promise<IntegrationCheck | undefined> {
  const stored = await getIntegration(id);
  if (!stored) return undefined;
  const { integration } = stored;
  const secret = await resolveIntegrationToken(id);
  if (!secret) return { ok: false, reason: 'no token is stored for this integration' };
  if (secret.boundOrigin !== originOf(integration.apiBaseUrl)) return { ok: false, reason: 'the stored token is bound to another origin than the API address' };
  const outcome = await checkGithubAccess({ apiBaseUrl: integration.apiBaseUrl, repo: integration.repo, token: secret.token });
  if (!outcome.ok) return { ok: false, reason: outcome.reason, ...(outcome.httpStatus === undefined ? {} : { httpStatus: outcome.httpStatus }) };
  return outcome.issuesEnabled ? { ok: true, issuesEnabled: true } : { ok: false, issuesEnabled: false, reason: 'issues are turned off for this repository' };
}
