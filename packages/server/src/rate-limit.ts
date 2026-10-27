// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyRequest } from 'fastify';

/**
 * Global rate limit: 100 requests a minute per signed-in actor, or per
 * IP for anyone not signed in.
 *
 * Keyed by IP alone, everything on one host shared a bucket: the web
 * client, every local agent and service. A few pollers were enough to
 * 429 the owner's own page loads. Keying by actor gives each its own.
 *
 * The limit runs at preHandler, after the auth plugin's onRequest hook
 * has set `request.actor`. A forged or expired cookie sets no actor, so
 * it falls back to the IP bucket and can't buy a fresh one. A bad bearer
 * token is refused in onRequest, before this runs; token secrets are 32
 * random bytes, so that path isn't worth limiting.
 */
export function rateLimitKey(request: FastifyRequest): string {
  return request.actor ? `actor:${request.actor.id}` : `ip:${request.ip}`;
}

export const rateLimitOptions = {
  max: 100,
  timeWindow: '1 minute',
  hook: 'preHandler' as const,
  keyGenerator: rateLimitKey,
};
