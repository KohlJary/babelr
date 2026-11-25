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

/**
 * Tighter limits for the doors themselves, keyed by IP alone (a session
 * doesn't buy more password guesses). Behind a tunnel or reverse proxy,
 * set TRUST_PROXY so request.ip is the visitor's address, not the
 * proxy's: otherwise every visitor shares one bucket.
 *
 * Per route, on top of the global limit:
 * - login and the 2FA challenge: 10 a minute
 * - register: 10 per 15 minutes
 * - invite lookups by code (anonymous): 30 a minute
 */
export function authRateLimitKey(request: FastifyRequest): string {
  return `ip:${request.ip}`;
}

export const LOGIN_RATE_LIMIT = {
  max: 10,
  timeWindow: '1 minute',
  keyGenerator: authRateLimitKey,
};

export const REGISTER_RATE_LIMIT = {
  max: 10,
  timeWindow: '15 minutes',
  keyGenerator: authRateLimitKey,
};

export const INVITE_LOOKUP_RATE_LIMIT = {
  max: 30,
  timeWindow: '1 minute',
  keyGenerator: authRateLimitKey,
};
