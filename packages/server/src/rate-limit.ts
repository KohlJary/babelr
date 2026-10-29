// SPDX-License-Identifier: MIT
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

/**
 * Signed-in actors get 300 a minute, everyone else 100. One page load
 * of the web client makes a few dozen API calls, and switching channels
 * makes three more each time; at 100, a person reloading twice was
 * locked out of their own server.
 */
export const SIGNED_IN_MAX = 300;
export const ANONYMOUS_MAX = 100;

export function rateLimitMax(request: FastifyRequest): number {
  return request.actor ? SIGNED_IN_MAX : ANONYMOUS_MAX;
}

/**
 * The built client and uploads are files, not API calls: a page load
 * fetches about thirty script chunks, and counting them spent most of a
 * person's minute before the app had asked for anything.
 */
const STATIC_PATH =
  /^\/(?:assets\/|uploads\/|sw\.js$|registerSW\.js$|manifest\.webmanifest$|favicon|index\.html$|$)/;

export function isStaticRequest(request: FastifyRequest): boolean {
  return (
    (request.method === 'GET' || request.method === 'HEAD') &&
    STATIC_PATH.test(request.url.split('?')[0])
  );
}

export const rateLimitOptions = {
  max: rateLimitMax,
  timeWindow: '1 minute',
  hook: 'preHandler' as const,
  keyGenerator: rateLimitKey,
  allowList: isStaticRequest,
};
