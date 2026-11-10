/**
 * T10.1 roles. Pure: no configuration, no I/O.
 *
 *  - `viewer`: reads (GET/HEAD): history, reports, health, evidence. Starts nothing, changes nothing.
 *  - `runner`: what a UI session could always do: starts runs, suites and drafts, saves routines. (Writes that a person must
 *    approve with the API key -- credentials, target profiles, pins, schedules, webhooks, sending a bug report -- stay `admin`.)
 *  - `admin`: everything the API key could do, plus team management and the audit log.
 *
 * The key in `.env` (SCRAPFORAI_API_KEY) is the installation's own `root` admin: it is how the first user is created, and it cannot be
 * locked out by editing the users.
 */
export const ROLES = ['viewer', 'runner', 'admin'] as const;
export type Role = (typeof ROLES)[number];

const RANK: Record<Role, number> = { viewer: 1, runner: 2, admin: 3 };

export const roleAtLeast = (have: Role, need: Role): boolean => RANK[have] >= RANK[need];

/** What a user id looks like (also what a credential set's `allowedUsers` accepts). One pattern, so the two can never disagree. */
export const USER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,59}$/;
export const USER_ID_MESSAGE = 'user id: lower-case letters, digits, . _ - (1-60, starting with a letter or digit)';

/** The id the `.env` key acts as. Reserved: no user can take it (or the ones the server itself acts as). */
export const ROOT_USER_ID = 'root';
export const RESERVED_USER_IDS: readonly string[] = [ROOT_USER_ID, 'system', 'scheduler', 'anonymous'];

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The lowest role that may make this request. One place, so the whole policy can be read (and tested) at once; a route that needs more
 * (the API key itself) says so with `requireBearer`.
 */
export function requiredRole(method: string, requestPath: string): Role {
  const verb = method.toUpperCase();
  // Who is signed in / signing out concerns any authenticated person.
  if (requestPath === '/v1/auth' || requestPath.startsWith('/v1/auth/')) return 'viewer';
  // People and the log of what they did are for admins, reads included.
  if (/^\/v1\/(team|audit)(\/|$)/.test(requestPath)) return 'admin';
  // Reading the configuration is fine; changing it is not for a runner (it moves the allowlist of origins, among other things).
  if (requestPath === '/v1/config' || requestPath.startsWith('/v1/config/')) return READ_METHODS.has(verb) ? 'viewer' : 'admin';
  return READ_METHODS.has(verb) ? 'viewer' : 'runner';
}
