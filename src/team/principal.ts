import { ROOT_USER_ID, type Role } from './roles.js';

/** Who is making a request (T10.1). Set by `apiAuth`. */
export interface Principal {
  userId: string;
  role: Role;
  /** `bearer`: sent the key in the request. `session`: signed in through the web console (a cookie). */
  via: 'bearer' | 'session';
  /** The installation's own key (`SCRAPFORAI_API_KEY`) acting as `root`. */
  master: boolean;
  /** Which personal key (not set for the installation's own key). */
  keyId?: string;
}

export const masterPrincipal = (via: Principal['via']): Principal => ({ userId: ROOT_USER_ID, role: 'admin', via, master: true });

export const auditActor = (principal: Principal): { userId: string; role: string; via: 'bearer' | 'session'; keyId?: string } => ({
  userId: principal.userId,
  role: principal.role,
  via: principal.via,
  ...(principal.keyId ? { keyId: principal.keyId } : {}),
});
