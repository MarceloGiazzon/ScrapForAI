import type { Principal } from './principal.js';
import { roleAtLeast, type Role } from './roles.js';

/**
 * Who a piece of work is done FOR, carried from the request that started it to the place where a credential set is loaded.
 *
 * A suite, a permission matrix, a shrink, a differential or a snapshot runs in the background, long after the request that
 * started it has been answered, so "who asked" cannot be looked up at that point: it has to travel with the work. It is a
 * REQUIRED argument everywhere on that path (not an optional one), so a new caller cannot forget it and silently run unrestricted.
 *
 *  - `'system'`: the server acting on its own account: the scheduler (a schedule is created by an admin), the stores that read their own
 *    vault sets (webhook URL, integration token), tests.
 *  - a person: the user id and role the request was authenticated as. Pure: no configuration, no I/O.
 */
export type Initiator = 'system' | { userId: string; role: Role };

export const SYSTEM_INITIATOR: Initiator = 'system';

/**
 * Who a run was started for, as it is RECORDED in the result and the run history. The server sets it from the initiator
 * (`resolveExplorationRequest`); a request cannot carry it, so it cannot be claimed for someone else. `system` has no role: it is the
 * server acting on its own account (today: the scheduler). A run started with the installation's own key is `root`, an admin, as everywhere else.
 */
export interface StartedBy {
  userId: string;
  role?: Role;
}

export function startedByOf(who: Initiator): StartedBy {
  return who === 'system' ? { userId: 'system' } : { userId: who.userId, role: who.role };
}

/**
 * The initiator of an HTTP request. A request with no principal (a router mounted without `apiAuth`, which only tests do) is treated as the
 * lowest, anonymous caller: it can use what is open to everyone and nothing that is restricted. Failing closed costs nothing here.
 */
export function initiatorOf(principal: Principal | undefined): Initiator {
  return principal ? { userId: principal.userId, role: principal.role } : { userId: 'anonymous', role: 'viewer' };
}

/**
 * May this initiator use something (a credential set, a target profile) whose `allowedUsers` is this?
 *  - no list (never restricted): anyone who can run, as before;
 *  - an admin: always (an admin edits the list, so excluding one would only be a detour) and `'system'`;
 *  - anyone else: only a user named in the list. An EMPTY list restricts it to admins.
 * One rule for every restrictable thing, so they cannot drift apart.
 */
export function mayUseRestricted(allowedUsers: readonly string[] | undefined, who: Initiator): boolean {
  if (allowedUsers === undefined) return true;
  if (who === 'system') return true;
  if (roleAtLeast(who.role, 'admin')) return true;
  return allowedUsers.includes(who.userId);
}

export const mayUseCredentialSet = mayUseRestricted;
export const mayUseTargetProfile = mayUseRestricted;
