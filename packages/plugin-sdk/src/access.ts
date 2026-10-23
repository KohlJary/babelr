// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PluginCaller } from './types.js';

/**
 * Access helpers for plugin routes. The Tower implements the checks
 * (it owns the membership and role tables) and exposes them on
 * `fastify.pluginAccess`; these wrappers are what plugin code calls.
 *
 * The convention every first-party plugin follows:
 *   - Anything scoped to a server (a Group actor id) is visible only
 *     to members of that server, for reads and writes alike.
 *   - A non-member gets 404, never 403, so they can't confirm that a
 *     slug or a server exists.
 *   - Changing or removing something is for its creator, or for a
 *     server admin (the MANAGE_SERVER permission). A member who is
 *     neither gets 403: membership already lets them see the item.
 */

/** Anyone who might be calling: a session actor, a federated caller,
 *  or nobody. */
type MaybeCaller = Pick<PluginCaller, 'uri'> & Partial<PluginCaller>;

/** Is `caller` a member of the server `serverId`? False for a missing
 *  caller, a malformed id, or a server that doesn't exist. */
export async function canAccess(
  fastify: FastifyInstance,
  caller: MaybeCaller | null | undefined,
  serverId: string,
): Promise<boolean> {
  if (!caller?.uri) return false;
  return fastify.pluginAccess.isMember({ uri: caller.uri }, serverId);
}

/**
 * Route guard: true if the session actor is a member of `serverId`.
 * Otherwise sends 404 and returns false, so a handler reads:
 *
 *   if (!(await requireMember(request, reply, serverId))) return reply;
 */
export async function requireMember(
  request: FastifyRequest,
  reply: FastifyReply,
  serverId: string,
): Promise<boolean> {
  if (await canAccess(request.server, request.actor, serverId)) return true;
  reply.status(404).send({ error: 'Not found' });
  return false;
}

/** Is `caller` the item's creator (`ownerId`), or an admin of the
 *  server it belongs to? Only local actors can hold admin. */
export async function canManage(
  fastify: FastifyInstance,
  caller: (Pick<PluginCaller, 'id'> & Partial<PluginCaller>) | null | undefined,
  serverId: string | null,
  ownerId: string,
): Promise<boolean> {
  if (!caller?.id) return false;
  if (caller.id === ownerId) return true;
  if (!serverId || caller.local === false) return false;
  return fastify.pluginAccess.isServerAdmin({ id: caller.id }, serverId);
}
