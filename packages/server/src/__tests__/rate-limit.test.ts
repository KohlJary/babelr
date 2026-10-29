// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { ANONYMOUS_MAX, SIGNED_IN_MAX, rateLimitOptions } from '../rate-limit.ts';

// Stands in for the auth plugin: header x-actor sets request.actor in
// onRequest, the way a valid session cookie or token does.
async function app(max?: number) {
  const f = Fastify();
  f.decorateRequest('actor', undefined);
  f.addHook('onRequest', async (req) => {
    const id = req.headers['x-actor'];
    if (typeof id === 'string') req.actor = { id } as typeof req.actor;
  });
  await f.register(rateLimit, max === undefined ? rateLimitOptions : { ...rateLimitOptions, max });
  f.get('/', async () => ({ ok: true }));
  f.get('/api-ish', async () => ({ ok: true }));
  f.get('/assets/chunk.js', async () => 'js');
  await f.ready();
  return f;
}

const hit = (f: Awaited<ReturnType<typeof app>>, actor?: string) =>
  f.inject({ method: 'GET', url: '/api-ish', headers: actor ? { 'x-actor': actor } : {} });

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

  it('never counts the built client or uploads', async () => {
    const f = await app(2);
    for (let i = 0; i < 10; i++) {
      expect(
        (
          await f.inject({
            method: 'GET',
            url: '/assets/chunk.js',
            headers: { 'x-actor': 'owner' },
          })
        ).statusCode,
      ).toBe(200);
    }
    expect((await hit(f, 'owner')).statusCode).toBe(200);
  });

  it('gives a signed-in actor more room than an anonymous IP', async () => {
    const f = await app();
    const get = (actor?: string) =>
      f.inject({ method: 'GET', url: '/api-ish', headers: actor ? { 'x-actor': actor } : {} });
    for (let i = 0; i < ANONYMOUS_MAX; i++) await get();
    expect((await get()).statusCode).toBe(429);
    for (let i = 0; i < SIGNED_IN_MAX; i++) expect((await get('owner')).statusCode).toBe(200);
    expect((await get('owner')).statusCode).toBe(429);
  });

  it('still limits requests with no actor, by IP', async () => {
    const f = await app(2);
    await hit(f);
    await hit(f);
    expect((await hit(f)).statusCode).toBe(429);
  });
});
