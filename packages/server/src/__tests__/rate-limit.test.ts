// SPDX-License-Identifier: Hippocratic-3.0
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { rateLimitOptions } from '../rate-limit.ts';

// Stands in for the auth plugin: header x-actor sets request.actor in
// onRequest, the way a valid session cookie or token does.
async function app(max: number) {
  const f = Fastify();
  f.decorateRequest('actor', undefined);
  f.addHook('onRequest', async (req) => {
    const id = req.headers['x-actor'];
    if (typeof id === 'string') req.actor = { id } as typeof req.actor;
  });
  await f.register(rateLimit, { ...rateLimitOptions, max });
  f.get('/', async () => ({ ok: true }));
  await f.ready();
  return f;
}

const hit = (f: Awaited<ReturnType<typeof app>>, actor?: string) =>
  f.inject({ method: 'GET', url: '/', headers: actor ? { 'x-actor': actor } : {} });

describe('rate limit', () => {
  it('gives each signed-in actor its own bucket on one IP', async () => {
    const f = await app(2);
    expect((await hit(f, 'poller')).statusCode).toBe(200);
    expect((await hit(f, 'poller')).statusCode).toBe(200);
    expect((await hit(f, 'poller')).statusCode).toBe(429);
    // Same IP, different actor: the poller's exhaustion doesn't touch it.
    expect((await hit(f, 'owner')).statusCode).toBe(200);
    expect((await hit(f)).statusCode).toBe(200);
  });

  it('still limits requests with no actor, by IP', async () => {
    const f = await app(2);
    await hit(f);
    await hit(f);
    expect((await hit(f)).statusCode).toBe(429);
  });
});
