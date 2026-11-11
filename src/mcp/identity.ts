import { env } from '../config/env.js';
import { parseKeyId } from '../team/keys.js';

/**
 * Who the MCP server acts as. Kept apart from `config.ts` ON PURPOSE: the CLI shares that file (address and timeout) and must keep acting with the
 * installation key. `SCRAPFORAI_MCP_API_KEY` is read from the user's environment, which every process of that session inherits, the CLI a person
 * runs from a terminal included; if the CLI read it too, the admin who restricts their agent would find their own `users create` refused.
 */

/** Who the MCP server acts as: a person with a personal key, or the installation itself (`root`, an admin). */
export type McpIdentity = { source: 'personal'; keyId: string } | { source: 'installation' };

/**
 * Which key the MCP server sends to the REST API, and as whom. Pure apart from its two arguments, so it is tested directly.
 *
 *  - `SCRAPFORAI_MCP_API_KEY` set: a PERSONAL key (`sfa_<id>_<secret>`, made by an admin: `scrapforai users key-create`). Every call is that person's, so what the
 *    team restricts (a credential set's or a target profile's `allowedUsers`, a viewer's read-only role) holds for the agent too. A value that is not shaped
 *    like a personal key is an ERROR, never a silent fall back to the installation key: a typo must not turn a person's agent into `root`.
 *  - not set (or empty, as an unset `${VAR:-}` expands): the installation's key, `SCRAPFORAI_API_KEY`, as before. It is `root`, an admin: nothing is restricted.
 *
 * The key is never printed or put in an error; only a personal key's id (public: it is in the audit log) is.
 */
export function resolveMcpApiKey(vars: NodeJS.ProcessEnv, installationKey: string): { apiKey: string; identity: McpIdentity } {
  const personal = vars.SCRAPFORAI_MCP_API_KEY?.trim();
  if (!personal) {
    return { apiKey: installationKey, identity: { source: 'installation' } };
  }

  const keyId = parseKeyId(personal);
  if (keyId === undefined) {
    throw new Error('SCRAPFORAI_MCP_API_KEY is set but is not a personal key (it looks like sfa_<12 hex>_<secret>). Unset it to act with the installation key, or ask an admin for a key: scrapforai users key-create <user>.');
  }
  return { apiKey: personal, identity: { source: 'personal', keyId } };
}

/** One line for the log of whoever started the server (stderr: stdout is the protocol). */
export function describeMcpIdentity(identity: McpIdentity): string {
  return identity.source === 'personal'
    ? `acting with the personal key ${identity.keyId} (the person who owns it: their role and their allowed credential sets and target profiles apply)`
    : 'acting with the installation key (root, an admin): nothing is restricted. Set SCRAPFORAI_MCP_API_KEY to a personal key to act as one person.';
}

/** Read once, when the MCP server starts (or its client is first imported). */
export const mcpCredentials = resolveMcpApiKey(process.env, env.SCRAPFORAI_API_KEY);
