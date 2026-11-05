import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { teamDir } from '../config/paths.js';
import { retryTransient } from '../storage/transientIo.js';
import { generateKey, hashesMatch, hashKey, parseKeyId } from './keys.js';
import { RESERVED_USER_IDS, ROLES, type Role } from './roles.js';

/**
 * T10.1 people and their personal API keys: `<dataDir>/team/users.json`.
 *
 * The file holds roles and the SHA-256 of each key, never a key. It is read once and kept in memory (the server is one process); every change
 * is written to a temporary file and renamed, so a crash leaves the previous list. A key is checked on every request, so a disabled user, a
 * revoked or expired key stops working at once, and `principalStillValid` lets a session notice the same.
 */

export class TeamError extends Error {
  constructor(
    readonly status: number,
    name: string,
    message: string,
  ) {
    super(message);
    this.name = name;
  }
}

export const MAX_USERS = 200;
export const MAX_ACTIVE_KEYS_PER_USER = 10;
/** `lastUsedAt` is written to disk at most this often per key (a request must not cost a file write). */
const LAST_USED_WRITE_INTERVAL_MS = 10 * 60 * 1000;

export const userIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,59}$/, 'user id: lower-case letters, digits, . _ - (1-60, starting with a letter or digit)');
export const roleSchema = z.enum(ROLES);

const keyRecordSchema = z
  .object({
    id: z.string().regex(/^[0-9a-f]{12}$/),
    label: z.string().max(80).optional(),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    createdAt: z.string(),
    expiresAt: z.string().optional(),
    revokedAt: z.string().optional(),
    lastUsedAt: z.string().optional(),
  })
  .strict();
const userRecordSchema = z
  .object({
    id: userIdSchema,
    name: z.string().min(1).max(120),
    role: roleSchema,
    disabled: z.boolean().default(false),
    createdAt: z.string(),
    createdBy: z.string(),
    keys: z.array(keyRecordSchema).max(100).default([]),
  })
  .strict();
const fileSchema = z.object({ version: z.literal(1), users: z.array(userRecordSchema) }).strict();

type KeyRecord = z.infer<typeof keyRecordSchema>;
type UserRecord = z.infer<typeof userRecordSchema>;

export interface KeyView {
  id: string;
  label?: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  lastUsedAt?: string;
  active: boolean;
}
export interface UserView {
  id: string;
  name: string;
  role: Role;
  disabled: boolean;
  createdAt: string;
  createdBy: string;
  keys: KeyView[];
}

export const createUserInputSchema = z.object({ id: userIdSchema, name: z.string().trim().min(1).max(120), role: roleSchema }).strict();
export const updateUserInputSchema = z
  .object({ name: z.string().trim().min(1).max(120).optional(), role: roleSchema.optional(), disabled: z.boolean().optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'nothing to change' });
export const createKeyInputSchema = z
  .object({ label: z.string().trim().min(1).max(80).optional(), expiresAt: z.iso.datetime({ offset: true }).optional() })
  .strict();

const usersFile = (): string => path.join(teamDir(), 'users.json');

let cache: UserRecord[] | undefined;
let loading: Promise<UserRecord[]> | undefined;
let writeChain: Promise<void> = Promise.resolve();
const lastWrittenUse = new Map<string, number>();

async function load(): Promise<UserRecord[]> {
  if (cache) return cache;
  loading ??= (async () => {
    try {
      const raw = await fs.readFile(usersFile(), 'utf8');
      const parsed = fileSchema.safeParse(JSON.parse(raw));
      // A damaged file must not become "no users" silently: a person has to look at it.
      if (!parsed.success) throw new TeamError(500, 'UsersFileInvalid', `${usersFile()} is not a valid users file; fix or restore it (the server will not guess)`);
      cache = parsed.data.users;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      cache = [];
    }
    return cache;
  })();
  try {
    return await loading;
  } finally {
    loading = undefined;
  }
}

function persist(users: UserRecord[]): Promise<void> {
  const write = async (): Promise<void> => {
    await fs.mkdir(teamDir(), { recursive: true });
    const file = usersFile();
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({ version: 1, users }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await retryTransient(() => fs.rename(temporary, file), { label: 'users.json' });
  };
  // Writes are queued: two changes at once must not interleave their temporary files.
  const next = writeChain.then(write, write);
  writeChain = next.catch(() => undefined);
  return next;
}

const isActive = (key: KeyRecord, now: number): boolean =>
  key.revokedAt === undefined && (key.expiresAt === undefined || Date.parse(key.expiresAt) > now);

const keyView = (key: KeyRecord, now: number): KeyView => ({
  id: key.id,
  ...(key.label ? { label: key.label } : {}),
  createdAt: key.createdAt,
  ...(key.expiresAt ? { expiresAt: key.expiresAt } : {}),
  ...(key.revokedAt ? { revokedAt: key.revokedAt } : {}),
  ...(key.lastUsedAt ? { lastUsedAt: key.lastUsedAt } : {}),
  active: isActive(key, now),
});

/** No hash ever leaves the store. */
const userView = (user: UserRecord, now = Date.now()): UserView => ({
  id: user.id,
  name: user.name,
  role: user.role,
  disabled: user.disabled,
  createdAt: user.createdAt,
  createdBy: user.createdBy,
  keys: user.keys.map((key) => keyView(key, now)),
});

let mutex: Promise<unknown> = Promise.resolve();

/**
 * Every change goes through here, one at a time: read the current list, compute the next one, keep it in memory and write it. If the write
 * fails the memory goes back to what the disk holds, so the two never disagree about who may sign in.
 */
function mutate<T>(change: (users: UserRecord[]) => { next: UserRecord[]; result: T }): Promise<T> {
  const run = async (): Promise<T> => {
    const users = await load();
    const { next, result } = change(users);
    cache = next;
    try {
      await persist(next);
    } catch (error) {
      cache = users;
      throw error;
    }
    return result;
  };
  const queued = mutex.then(run, run);
  mutex = queued.catch(() => undefined);
  return queued;
}

const notFound = (id: string): TeamError => new TeamError(404, 'UserNotFound', `User "${id}" does not exist`);

export async function listUsers(): Promise<UserView[]> {
  const now = Date.now();
  return (await load()).map((user) => userView(user, now)).sort((a, b) => a.id.localeCompare(b.id));
}

export async function getUser(id: string): Promise<UserView | undefined> {
  const user = (await load()).find((candidate) => candidate.id === id);
  return user ? userView(user) : undefined;
}

export async function createUser(input: z.infer<typeof createUserInputSchema>, createdBy: string): Promise<{ user: UserView; key: string }> {
  return mutate((users) => {
    if (RESERVED_USER_IDS.includes(input.id)) throw new TeamError(400, 'ReservedUserId', `"${input.id}" is reserved (the installation's own key acts as root)`);
    if (users.some((user) => user.id === input.id)) throw new TeamError(409, 'UserExists', `User "${input.id}" already exists`);
    if (users.length >= MAX_USERS) throw new TeamError(409, 'TooManyUsers', `At most ${MAX_USERS} users`);

    const generated = generateKey();
    const now = new Date().toISOString();
    const record: UserRecord = {
      id: input.id,
      name: input.name,
      role: input.role,
      disabled: false,
      createdAt: now,
      createdBy,
      keys: [{ id: generated.keyId, label: 'first key', hash: generated.hash, createdAt: now }],
    };
    return { next: [...users, record], result: { user: userView(record), key: generated.key } };
  });
}

export async function updateUser(id: string, input: z.infer<typeof updateUserInputSchema>): Promise<UserView> {
  return mutate((users) => {
    const index = users.findIndex((user) => user.id === id);
    if (index === -1) throw notFound(id);
    const updated: UserRecord = {
      ...users[index]!,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.role === undefined ? {} : { role: input.role }),
      ...(input.disabled === undefined ? {} : { disabled: input.disabled }),
    };
    return { next: users.map((user, position) => (position === index ? updated : user)), result: userView(updated) };
  });
}

export async function deleteUser(id: string): Promise<void> {
  await mutate((users) => {
    if (!users.some((user) => user.id === id)) throw notFound(id);
    return { next: users.filter((user) => user.id !== id), result: undefined };
  });
}

export async function addKey(userId: string, input: z.infer<typeof createKeyInputSchema>): Promise<{ key: string; view: KeyView }> {
  return mutate((users) => {
    const index = users.findIndex((user) => user.id === userId);
    if (index === -1) throw notFound(userId);
    const user = users[index]!;
    const now = Date.now();
    if (input.expiresAt !== undefined && Date.parse(input.expiresAt) <= now) throw new TeamError(400, 'ValidationError', 'expiresAt is already in the past');
    if (user.keys.filter((key) => isActive(key, now)).length >= MAX_ACTIVE_KEYS_PER_USER) {
      throw new TeamError(409, 'TooManyKeys', `User "${userId}" already has ${MAX_ACTIVE_KEYS_PER_USER} active keys; revoke one first`);
    }
    const generated = generateKey();
    const record: KeyRecord = {
      id: generated.keyId,
      ...(input.label ? { label: input.label } : {}),
      hash: generated.hash,
      createdAt: new Date(now).toISOString(),
      ...(input.expiresAt ? { expiresAt: new Date(input.expiresAt).toISOString() } : {}),
    };
    return {
      next: users.map((candidate, position) => (position === index ? { ...candidate, keys: [...candidate.keys, record] } : candidate)),
      result: { key: generated.key, view: keyView(record, now) },
    };
  });
}

export async function revokeKey(userId: string, keyId: string): Promise<KeyView> {
  return mutate((users) => {
    const user = users.find((candidate) => candidate.id === userId);
    if (!user) throw notFound(userId);
    const key = user.keys.find((candidate) => candidate.id === keyId);
    if (!key) throw new TeamError(404, 'KeyNotFound', `User "${userId}" has no key "${keyId}"`);
    const revoked: KeyRecord = key.revokedAt ? key : { ...key, revokedAt: new Date().toISOString() };
    return {
      next: users.map((candidate) => (candidate.id === userId ? { ...candidate, keys: candidate.keys.map((each) => (each.id === keyId ? revoked : each)) } : candidate)),
      result: keyView(revoked, Date.now()),
    };
  });
}

export interface KeyIdentity {
  userId: string;
  role: Role;
  keyId: string;
}

/** Who a personal key belongs to, or undefined (unknown, wrong, revoked, expired, user disabled). Always loads the users first. */
export async function authenticateUserKey(token: string): Promise<KeyIdentity | undefined> {
  const keyId = parseKeyId(token);
  if (!keyId) return undefined;
  const users = await load();
  const user = users.find((candidate) => candidate.keys.some((key) => key.id === keyId));
  const key = user?.keys.find((candidate) => candidate.id === keyId);
  if (!user || !key) return undefined;
  // Compared even when the key is no longer usable, so the time taken says nothing about why it was refused.
  const matches = hashesMatch(key.hash, hashKey(token));
  if (!matches || user.disabled || !isActive(key, Date.now())) return undefined;

  const now = Date.now();
  if (now - (lastWrittenUse.get(key.id) ?? 0) > LAST_USED_WRITE_INTERVAL_MS) {
    lastWrittenUse.set(key.id, now);
    // Best effort: losing a "last used" stamp must never refuse a request.
    void mutate((current) => ({
      next: current.map((candidate) =>
        candidate.id === user.id ? { ...candidate, keys: candidate.keys.map((each) => (each.id === key.id ? { ...each, lastUsedAt: new Date(now).toISOString() } : each)) } : candidate,
      ),
      result: undefined,
    })).catch(() => undefined);
  }
  return { userId: user.id, role: user.role, keyId: key.id };
}

/** For a session: is this user (and key) still allowed, and with which role right now? Reflects a role change or a revocation at once. */
export async function currentIdentity(userId: string, keyId: string): Promise<KeyIdentity | undefined> {
  const user = (await load()).find((candidate) => candidate.id === userId);
  const key = user?.keys.find((candidate) => candidate.id === keyId);
  if (!user || !key || user.disabled || !isActive(key, Date.now())) return undefined;
  return { userId: user.id, role: user.role, keyId: key.id };
}

/** Tests only: forget what was read, so the next call reads the file again. */
export function resetTeamCacheForTests(): void {
  cache = undefined;
  loading = undefined;
  lastWrittenUse.clear();
}
