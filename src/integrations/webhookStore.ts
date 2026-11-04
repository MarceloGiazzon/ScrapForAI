import fs from 'node:fs/promises';
import path from 'node:path';

import { webhooksDir } from '../config/paths.js';
import { type Webhook, webhookSchema, type WebhookState, webhookStateSchema } from '../schemas/webhook.schema.js';
import { createMutex, writeFileAtomic } from '../storage/atomicWrite.js';
import { deleteCredentialSet, getCredentialSetMeta, resolveCredentialSet, saveCredentialSet } from '../vault/credentials/credentialVault.js';

/**
 * T3.3 persistence. A webhook has THREE parts, kept apart on purpose:
 *   - the definition (<dataDir>/webhooks/<id>.json): preset, language, events, summary time. Nothing secret.
 *   - the URL: a credential-vault set `webhook-<id>` (field `url`, bound to the URL's origin). Encrypted, write-only.
 *   - the state (<dataDir>/webhooks/state/<id>.json): what the channel was told, and the last deliveries.
 */

export const DELIVERY_LIMIT = 50;
const withLock = createMutex();

const definitionFile = (id: string): string => path.join(webhooksDir(), `${id}.json`);
const stateFile = (id: string): string => path.join(webhooksDir(), 'state', `${id}.json`);
export const vaultSetId = (id: string): string => `webhook-${id}`;

export interface StoredWebhook {
  webhook: Webhook;
  createdAt: string;
  updatedAt: string;
}

async function readJson(file: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function getWebhook(id: string): Promise<StoredWebhook | undefined> {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return undefined;
  const raw = (await readJson(definitionFile(id))) as { webhook?: unknown; createdAt?: string; updatedAt?: string } | undefined;
  if (!raw) return undefined;
  return {
    webhook: webhookSchema.parse(raw.webhook),
    createdAt: raw.createdAt ?? new Date(0).toISOString(),
    updatedAt: raw.updatedAt ?? raw.createdAt ?? new Date(0).toISOString(),
  };
}

export async function listWebhooks(): Promise<StoredWebhook[]> {
  const files = await fs.readdir(webhooksDir()).catch(() => [] as string[]);
  const out: StoredWebhook[] = [];
  for (const file of files.filter((name) => name.endsWith('.json')).sort()) {
    const stored = await getWebhook(file.slice(0, -'.json'.length)).catch(() => undefined);
    if (stored) out.push(stored);
  }
  return out;
}

export function putWebhook(webhook: Webhook, nowIso: string): Promise<{ stored: StoredWebhook; created: boolean }> {
  return withLock(async () => {
    const previous = await getWebhook(webhook.id);
    const stored: StoredWebhook = { webhook, createdAt: previous?.createdAt ?? nowIso, updatedAt: nowIso };
    await writeFileAtomic(definitionFile(webhook.id), `${JSON.stringify(stored, null, 2)}\n`);

    // A summary scheduled today must not be "made up" for the hours before the webhook existed (or before the time was changed).
    const summaryChanged = JSON.stringify(previous?.webhook.dailySummary) !== JSON.stringify(webhook.dailySummary);
    const state = (await readState(webhook.id)) ?? emptyState(webhook.id);
    if (webhook.dailySummary && (summaryChanged || !state.lastSummaryAt)) {
      state.lastSummaryAt = nowIso;
      delete state.lastSummaryAttemptAt;
    }
    await writeFileAtomic(stateFile(webhook.id), `${JSON.stringify(state, null, 2)}\n`);
    return { stored, created: previous === undefined };
  });
}

export function deleteWebhook(id: string): Promise<boolean> {
  return withLock(async () => {
    const existed = (await getWebhook(id)) !== undefined;
    await fs.rm(definitionFile(id), { force: true });
    await fs.rm(stateFile(id), { force: true });
    await deleteCredentialSet(vaultSetId(id)).catch(() => false);
    return existed;
  });
}

// ---- the URL (credential vault) ---------------------------------------------------------------------------------------------------------

/** Stores the URL as the vault set `webhook-<id>`, bound to the URL's own origin. */
export async function saveWebhookUrl(id: string, url: string): Promise<void> {
  await saveCredentialSet(vaultSetId(id), { boundOrigins: [new URL(url).origin], values: { url }, tags: ['webhook'], notes: 'Webhook URL (T3.3). Write-only.' }, 'upsert');
}

/** SENDER ONLY. The URL is a secret: never put it in a response, a log line or a message. */
export async function resolveWebhookUrl(id: string): Promise<string | undefined> {
  return (await resolveCredentialSet(vaultSetId(id)))?.values.url;
}

/** The origin the URL points at (not secret: it is in ALLOWED_NOTIFY_ORIGINS), or undefined when no URL is stored. */
export async function webhookUrlOrigin(id: string): Promise<string | undefined> {
  return (await getCredentialSetMeta(vaultSetId(id)))?.boundOrigins[0];
}

// ---- the state ----------------------------------------------------------------------------------------------------------------------------

const emptyState = (id: string): WebhookState => ({ webhookId: id, subjects: {}, deliveries: [] });

async function readState(id: string): Promise<WebhookState | undefined> {
  const raw = await readJson(stateFile(id));
  return raw === undefined ? undefined : webhookStateSchema.parse(raw);
}

export async function getWebhookState(id: string): Promise<WebhookState> {
  return (await readState(id)) ?? emptyState(id);
}

/** Read-modify-write of one webhook's state under a lock. A webhook deleted meanwhile does not get its state file back. */
export function updateWebhookState(id: string, change: (state: WebhookState) => void): Promise<WebhookState> {
  return withLock(async () => {
    const state = (await readState(id)) ?? emptyState(id);
    change(state);
    if (!(await readJson(definitionFile(id)))) return state;
    if (state.deliveries.length > DELIVERY_LIMIT) state.deliveries.splice(0, state.deliveries.length - DELIVERY_LIMIT);
    await writeFileAtomic(stateFile(id), `${JSON.stringify(state, null, 2)}\n`);
    return state;
  });
}
