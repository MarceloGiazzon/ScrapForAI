import fs from 'node:fs/promises';
import path from 'node:path';

import { integrationsDir } from '../config/paths.js';
import { type Integration, integrationSchema } from '../schemas/integration.schema.js';
import { createMutex, writeFileAtomic } from '../storage/atomicWrite.js';
import { deleteCredentialSet, getCredentialSetMeta, resolveCredentialSet, saveCredentialSet } from '../vault/credentials/credentialVault.js';

/**
 * T9.1 persistence of an integration: the definition (<dataDir>/integrations/<id>.json: repo, labels, what a scheduled failure does; nothing secret)
 * and the API token, which lives in the credential vault as the set `integration-<id>` (field `token`, bound to the API origin).
 */

const withLock = createMutex();
const ID = /^[a-zA-Z0-9_-]{1,60}$/;
const definitionFile = (id: string): string => path.join(integrationsDir(), `${id}.json`);
export const integrationVaultSetId = (id: string): string => `integration-${id}`;

export interface StoredIntegration {
  integration: Integration;
  createdAt: string;
  updatedAt: string;
}

export async function getIntegration(id: string): Promise<StoredIntegration | undefined> {
  if (!ID.test(id)) return undefined;
  let raw: { integration?: unknown; createdAt?: string; updatedAt?: string };
  try {
    raw = JSON.parse(await fs.readFile(definitionFile(id), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return {
    integration: integrationSchema.parse(raw.integration),
    createdAt: raw.createdAt ?? new Date(0).toISOString(),
    updatedAt: raw.updatedAt ?? raw.createdAt ?? new Date(0).toISOString(),
  };
}

export async function listIntegrations(): Promise<StoredIntegration[]> {
  const files = await fs.readdir(integrationsDir()).catch(() => [] as string[]);
  const out: StoredIntegration[] = [];
  for (const file of files.filter((name) => name.endsWith('.json')).sort()) {
    const stored = await getIntegration(file.slice(0, -'.json'.length)).catch(() => undefined);
    if (stored) out.push(stored);
  }
  return out;
}

export function putIntegration(integration: Integration, nowIso: string): Promise<{ stored: StoredIntegration; created: boolean }> {
  return withLock(async () => {
    const previous = await getIntegration(integration.id);
    const stored: StoredIntegration = { integration, createdAt: previous?.createdAt ?? nowIso, updatedAt: nowIso };
    await writeFileAtomic(definitionFile(integration.id), `${JSON.stringify(stored, null, 2)}\n`);
    return { stored, created: previous === undefined };
  });
}

export function deleteIntegration(id: string): Promise<boolean> {
  return withLock(async () => {
    const existed = (await getIntegration(id)) !== undefined;
    await fs.rm(definitionFile(id), { force: true });
    await deleteCredentialSet(integrationVaultSetId(id)).catch(() => false);
    return existed;
  });
}

/** Stores the token as the vault set `integration-<id>`, bound to the API's own origin. */
export async function saveIntegrationToken(id: string, token: string, apiOrigin: string): Promise<void> {
  await saveCredentialSet(integrationVaultSetId(id), { boundOrigins: [apiOrigin], values: { token }, tags: ['integration'], notes: 'Issue-tracker token (T9.1). Write-only.' }, 'upsert');
}

/** SENDER ONLY. The token is a secret: never put it in a response, a log line or a report. */
export async function resolveIntegrationToken(id: string): Promise<{ token: string; boundOrigin: string | undefined } | undefined> {
  const set = await resolveCredentialSet(integrationVaultSetId(id));
  const token = set?.values.token;
  return token ? { token, boundOrigin: set.boundOrigins[0] } : undefined;
}

/** The origin the token is bound to (not secret), or undefined when no token is stored. */
export async function integrationTokenOrigin(id: string): Promise<string | undefined> {
  return (await getCredentialSetMeta(integrationVaultSetId(id)))?.boundOrigins[0];
}
