import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { credentialVaultFile, vaultKeyFile } from '../../config/paths.js';
import type { CredentialSetMeta, CredentialSetWrite } from '../../schemas/credentialSet.schema.js';
import { safeName } from '../../schemas/explorationRequest.schema.js';
import { createMutex, writeFileAtomic } from '../../storage/atomicWrite.js';
import { restrictToCurrentUser } from '../../storage/restrictFile.js';
import { type Initiator, mayUseCredentialSet } from '../../team/initiator.js';

/**
 * T1.2 server-side credential vault.
 *
 * - <dataDir>/credentials.enc.json holds every credential set, encrypted as ONE AES-256-GCM blob.
 * - The key is SCRAPFORAI_VAULT_KEY (32 bytes, base64) or <dataDir>/vault.key, generated on first
 *   use with an owner-only ACL.
 * - Values are write-only: nothing here returns them except `resolveCredentialSet`, which is for
 *   the runner alone and never reaches an HTTP/MCP response.
 *
 * Threat model: this protects against the model/caller and against casual disclosure of the file
 * (backup, repo, screen share). It does NOT protect against an attacker who can read both the data
 * directory and the key. Use SCRAPFORAI_VAULT_KEY to keep the key off the same disk.
 */

const FORMAT_VERSION = 1;
const AAD = Buffer.from(`scrapforai-credential-vault-v${FORMAT_VERSION}`);

export class VaultError extends Error {
  constructor(
    readonly status: number,
    name: string,
    message: string,
  ) {
    super(message);
    this.name = name;
  }
}

interface StoredSet {
  id: string;
  boundOrigins: string[];
  values: Record<string, string>;
  tags: string[];
  notes?: string;
  /** Who may use the set in a run (user ids). Absent = anyone who can run (the state of every set made before this existed). */
  allowedUsers?: string[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
}

interface VaultPayload {
  sets: Record<string, StoredSet>;
}

interface VaultFile {
  version: number;
  alg: 'aes-256-gcm';
  iv: string;
  tag: string;
  data: string;
}

export interface ResolvedCredentialSet {
  id: string;
  boundOrigins: string[];
  values: Record<string, string>;
}

const withLock = createMutex();

function decodeKey(encoded: string, source: string): Buffer {
  const key = Buffer.from(encoded.trim(), 'base64');
  if (key.length !== 32) {
    throw new VaultError(500, 'VaultKeyInvalid', `${source} must contain a 32-byte key encoded as base64`);
  }
  return key;
}

async function loadKey(): Promise<Buffer> {
  const fromEnv = process.env.SCRAPFORAI_VAULT_KEY?.trim();
  if (fromEnv) {
    return decodeKey(fromEnv, 'SCRAPFORAI_VAULT_KEY');
  }

  const file = vaultKeyFile();
  try {
    return decodeKey(await fs.readFile(file, 'utf8'), file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    // 'wx': never overwrite a key that appeared between the read above and now.
    await fs.writeFile(file, crypto.randomBytes(32).toString('base64'), { flag: 'wx', mode: 0o600 });
    await restrictToCurrentUser(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }

  return decodeKey(await fs.readFile(file, 'utf8'), file);
}

function encrypt(payload: VaultPayload, key: Buffer): VaultFile {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);

  return {
    version: FORMAT_VERSION,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function decrypt(file: VaultFile, key: Buffer): VaultPayload {
  if (file.version !== FORMAT_VERSION || file.alg !== 'aes-256-gcm') {
    throw new VaultError(500, 'VaultFormatUnsupported', 'Unsupported credential vault file format');
  }

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64'));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()]);
    return JSON.parse(plain.toString('utf8')) as VaultPayload;
  } catch {
    // Wrong key and tampering are indistinguishable by design. The message carries no content.
    throw new VaultError(500, 'VaultDecryptFailed', 'Credential vault could not be decrypted (wrong key or corrupted file)');
  }
}

// The file path is resolved ONCE per operation by the caller and passed in, so a read-modify-write
// can never read one location and write another.
async function readPayload(key: Buffer, file: string): Promise<VaultPayload> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { sets: {} };
    }
    throw error;
  }

  return decrypt(JSON.parse(raw) as VaultFile, key);
}

async function writePayload(payload: VaultPayload, key: Buffer, file: string): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(encrypt(payload, key))}\n`, 0o600);
}

function assertId(id: string): void {
  if (!safeName.safeParse(id).success) {
    throw new VaultError(400, 'ValidationError', 'Credential set id must match [a-zA-Z0-9_-]{1,80}');
  }
}

function toMeta(set: StoredSet): CredentialSetMeta {
  return {
    id: set.id,
    boundOrigins: set.boundOrigins,
    fields: Object.keys(set.values).sort(),
    tags: set.tags,
    ...(set.notes === undefined ? {} : { notes: set.notes }),
    restricted: set.allowedUsers !== undefined,
    ...(set.allowedUsers === undefined ? {} : { allowedUsers: [...set.allowedUsers] }),
    createdAt: set.createdAt,
    updatedAt: set.updatedAt,
    ...(set.lastUsedAt === undefined ? {} : { lastUsedAt: set.lastUsedAt }),
  };
}

export async function listCredentialSets(): Promise<CredentialSetMeta[]> {
  const payload = await readPayload(await loadKey(), credentialVaultFile());
  return Object.values(payload.sets)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(toMeta);
}

export async function getCredentialSetMeta(id: string): Promise<CredentialSetMeta | undefined> {
  assertId(id);
  const set = (await readPayload(await loadKey(), credentialVaultFile())).sets[id];
  return set ? toMeta(set) : undefined;
}

/**
 * Creates (`mode: 'create'`, fails if it exists) or creates-or-replaces (`mode: 'upsert'`; omitted
 * `values` keep the stored ones) a credential set.
 */
export function saveCredentialSet(id: string, body: CredentialSetWrite, mode: 'create' | 'upsert'): Promise<CredentialSetMeta> {
  assertId(id);

  return withLock(async () => {
    const key = await loadKey();
    const file = credentialVaultFile();
    const payload = await readPayload(key, file);
    const existing = payload.sets[id];

    if (mode === 'create' && existing) {
      throw new VaultError(409, 'CredentialSetExists', `Credential set "${id}" already exists (use PUT to update it)`);
    }

    const values = body.values ?? existing?.values;
    if (!values) {
      throw new VaultError(400, 'ValidationError', 'values are required when creating a credential set');
    }

    // Omitted keeps the stored list (an edit of an origin or a note must never open a restricted set); null removes the restriction.
    const allowedUsers = body.allowedUsers === undefined ? existing?.allowedUsers : (body.allowedUsers ?? undefined);

    const now = new Date().toISOString();
    const stored: StoredSet = {
      id,
      boundOrigins: body.boundOrigins,
      values,
      tags: body.tags,
      ...(body.notes === undefined ? {} : { notes: body.notes }),
      ...(allowedUsers === undefined ? {} : { allowedUsers }),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(existing?.lastUsedAt === undefined ? {} : { lastUsedAt: existing.lastUsedAt }),
    };

    payload.sets[id] = stored;
    await writePayload(payload, key, file);
    return toMeta(stored);
  });
}

export function deleteCredentialSet(id: string): Promise<boolean> {
  assertId(id);

  return withLock(async () => {
    const key = await loadKey();
    const file = credentialVaultFile();
    const payload = await readPayload(key, file);
    if (!payload.sets[id]) {
      return false;
    }

    delete payload.sets[id];
    await writePayload(payload, key, file);
    return true;
  });
}

/**
 * RUNNER ONLY. Returns the secret values of a set and records `lastUsedAt`. Never pass the result
 * to a response, log line or history entry; the runner adds the values to its redaction list.
 *
 * `initiator` is who the work is done for and is REQUIRED: a set with a list of allowed users answers 403 `CredentialSetForbidden` to anyone
 * else (admins and the server's own `'system'` aside), before the values are read out and without counting as a use. The message does not say
 * who is allowed.
 */
export async function resolveCredentialSet(id: string, initiator: Initiator): Promise<ResolvedCredentialSet | undefined> {
  assertId(id);
  const key = await loadKey();
  const file = credentialVaultFile();
  const set = (await readPayload(key, file)).sets[id];
  if (!set) {
    return undefined;
  }
  if (!mayUseCredentialSet(set.allowedUsers, initiator)) {
    throw new VaultError(403, 'CredentialSetForbidden', `You are not allowed to use credential set "${id}"; ask an admin to add you to its allowed users`);
  }

  // Best effort: a failure to record usage must never fail the run.
  void withLock(async () => {
    const payload = await readPayload(key, file);
    const current = payload.sets[id];
    if (current) {
      current.lastUsedAt = new Date().toISOString();
      await writePayload(payload, key, file);
    }
  }).catch(() => undefined);

  return { id: set.id, boundOrigins: set.boundOrigins, values: { ...set.values } };
}

/**
 * LINT ONLY (routine save, T1.3): every secret value in the vault, so a literal that equals one can
 * be refused. Returns [] without touching the key when no vault exists yet. Never returned by an API.
 */
export async function listAllCredentialValues(): Promise<string[]> {
  const file = credentialVaultFile();
  try {
    await fs.access(file);
  } catch {
    return [];
  }

  const payload = await readPayload(await loadKey(), file);
  return Object.values(payload.sets).flatMap((set) => Object.values(set.values));
}

/**
 * COMMIT GUARD ONLY (`scripts/secret-scan.ts`): every value with the set and field it belongs to, so a value about to be committed
 * can be named by its LABEL. Like `listAllCredentialValues`, it never creates a key: no vault file = [], and a vault file whose key is
 * missing is an error the caller reports. Never returned by an API.
 */
export async function listCredentialValuesForScan(): Promise<Array<{ setId: string; field: string; value: string }>> {
  const file = credentialVaultFile();
  try {
    await fs.access(file);
  } catch {
    return [];
  }
  if (!process.env.SCRAPFORAI_VAULT_KEY?.trim()) {
    try {
      await fs.access(vaultKeyFile());
    } catch {
      throw new VaultError(500, 'VaultKeyMissing','the credential vault exists but its key does not: values cannot be checked');
    }
  }

  const payload = await readPayload(await loadKey(), file);
  return Object.values(payload.sets).flatMap((set) => Object.entries(set.values).map(([field, value]) => ({ setId: set.id, field, value })));
}
