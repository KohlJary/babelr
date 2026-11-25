// SPDX-License-Identifier: MIT
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { eq } from 'drizzle-orm';
import '../types.ts';
import { invites } from '../db/schema/invites.ts';
import { welcomeAfterJoin } from '../welcome.ts';

/**
 * The welcome trigger: after a request that made someone a member of a
 * server succeeds, welcome them (welcome.ts). It hooks the response, not
 * the handlers, so the routes that add members (register, invite join,
 * public join) stay as they are:
 *
 *   POST /auth/register          with an inviteCode (invite-only sign-up)
 *   POST /invites/:code/join     the invite's maker is "invited by"
 *   POST /servers/:serverId/join a public server
 *
 * `onSend` runs before the response leaves, so by the time the client
 * has its answer the welcome DMs exist and its next GET /dms lists them.
 * The welcome itself never fails the request (welcomeNewcomer catches),
 * and a membership added by any other path is caught up by GET /dms.
 */

const CODE_RE = /^[A-Za-z0-9_-]{1,32}$/;

function bodyField(request: FastifyRequest, name: string): unknown {
  const body = request.body as Record<string, unknown> | null | undefined;
  return body && typeof body === 'object' ? body[name] : undefined;
}

/** The id in a successful register response (the new profile). */
function idFromPayload(payload: unknown): string | null {
  if (typeof payload !== 'string') return null;
  try {
    const parsed = JSON.parse(payload) as { id?: unknown };
    return typeof parsed.id === 'string' ? parsed.id : null;
  } catch {
    return null;
  }
}

async function welcomeTrigger(fastify: FastifyInstance) {
  async function viaInvite(code: unknown, newcomerId: string, via: string) {
    if (typeof code !== 'string' || !CODE_RE.test(code)) return;
    const [invite] = await fastify.db.select().from(invites).where(eq(invites.code, code)).limit(1);
    if (!invite) return;
    await welcomeAfterJoin(fastify, invite.serverId, newcomerId, {
      via,
      invitedById: invite.createdBy,
    });
  }

  fastify.addHook(
    'onSend',
    async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
      if (request.method !== 'POST' || reply.statusCode < 200 || reply.statusCode >= 300) {
        return payload;
      }
      const route = request.routeOptions?.url;
      try {
        if (route === '/invites/:code/join' && request.actor) {
          const { code } = request.params as { code?: string };
          await viaInvite(code, request.actor.id, 'invite');
        } else if (route === '/servers/:serverId/join' && request.actor) {
          const { serverId } = request.params as { serverId?: string };
          if (serverId) {
            await welcomeAfterJoin(fastify, serverId, request.actor.id, { via: 'join' });
          }
        } else if (route === '/auth/register') {
          const code = bodyField(request, 'inviteCode');
          const id = idFromPayload(payload);
          if (code && id) await viaInvite(code, id, 'register');
        }
      } catch (err) {
        fastify.log.error({ err, route }, 'Welcome trigger failed');
      }
      return payload;
    },
  );
}

export default fp(welcomeTrigger, {
  name: 'welcome-trigger',
  dependencies: ['db', 'config-plugin', 'ws'],
});
