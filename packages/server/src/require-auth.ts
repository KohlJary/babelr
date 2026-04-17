// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Fastify preHandler hook that rejects unauthenticated requests with
 * a 401. Add to individual routes or route-level hooks:
 *
 *   fastify.get('/foo', { preHandler: [requireAuth] }, handler);
 *
 * Or register as a route-level hook for an entire plugin:
 *
 *   fastify.addHook('preHandler', requireAuth);
 *
 * Routes that intentionally allow unauthenticated access (health,
 * auth/register, auth/login, federation endpoints) should NOT use
 * this hook.
 */
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!request.actor) {
    reply.status(401).send({ error: 'Not authenticated' });
  }
}
