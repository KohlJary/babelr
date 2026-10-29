// SPDX-License-Identifier: MIT
/**
 * Leaving a DM stops live delivery, over a real WebSocket. The other
 * tests stub the WS layer; this one mounts the real plugin and route.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fp from 'fastify-plugin';
import WebSocket from 'ws';
import { createDb } from '../db/index.ts';
import authPlugin from '../plugins/auth.ts';
import wsPlugin from '../plugins/ws.ts';
import wsRoutes from '../routes/ws.ts';
import authRoutes from '../routes/auth.ts';
import dmRoutes from '../routes/dms.ts';
import dmConsentRoutes from '../routes/dm-consent.ts';
import { testConfig } from './federation/helpers.ts';
import { cleanDb } from './helpers.ts';
import { enc } from './e2e-fixtures.ts';

let app: FastifyInstance;
let db: ReturnType<typeof createDb>;
let port: number;
const sockets: WebSocket[] = [];

beforeAll(async () => {
  db = createDb(testConfig.databaseUrl);
  app = Fastify({ logger: false });
  app.register(
    fp(
      async (f) => {
        f.decorate('db', db);
        f.decorate('config', testConfig);
      },
      { name: 'db' },
    ),
  );
  app.register(fp(async () => {}, { name: 'config-plugin' }));
  await app.register(cookie);
  await app.register(authPlugin);
  await app.register(wsPlugin);
  await app.register(wsRoutes);
  await app.register(authRoutes);
  await app.register(dmRoutes);
  await app.register(dmConsentRoutes);
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as { port: number }).port;
});

afterAll(async () => {
  for (const s of sockets) s.close();
  await app.close();
});

beforeEach(async () => {
  await cleanDb(db);
});

async function register(username: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { username, email: `${username}@t.local`, password: 'test-password-12chars' },
  });
  const raw = res.headers['set-cookie'];
  const c = (Array.isArray(raw) ? raw[0] : (raw as string)).split(';')[0];
  return { id: JSON.parse(res.body).id as string, cookie: c };
}

/** A connected socket and everything it has received. */
async function connect(cookieHeader: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: cookieHeader } });
  sockets.push(ws);
  const got: Array<{ type: string; payload: Record<string, unknown> }> = [];
  ws.on('message', (raw) => got.push(JSON.parse(raw.toString())));
  await new Promise<void>((resolve, reject) => {
    ws.once('error', reject);
    const check = () =>
      got.some((m) => m.type === 'connected') ? resolve() : setTimeout(check, 10);
    check();
  });
  return { ws, got };
}

const settle = () => new Promise((r) => setTimeout(r, 150));

describe('WS delivery and DM consent', () => {
  it('only participants can subscribe, and leaving stops delivery', async () => {
    const alice = await register('alice');
    const bob = await register('bob');
    const carol = await register('carol');
    const dm = await app.inject({
      method: 'POST',
      url: '/dms',
      headers: { cookie: alice.cookie },
      payload: { participantId: bob.id },
    });
    const dmId = JSON.parse(dm.body).id as string;

    const a = await connect(alice.cookie);
    const b = await connect(bob.cookie);
    const c = await connect(carol.cookie);
    for (const s of [a, b, c]) {
      s.ws.send(JSON.stringify({ type: 'channel:subscribe', payload: { channelId: dmId } }));
    }
    await settle();

    const send = async (content: string) => {
      const r = await app.inject({
        method: 'POST',
        url: `/dms/${dmId}/messages`,
        headers: { cookie: alice.cookie },
        payload: { content, properties: enc() },
      });
      await settle();
      return r.statusCode;
    };
    const newMessages = (s: { got: Array<{ type: string }> }) =>
      s.got.filter((m) => m.type === 'message:new').length;

    expect(await send('one')).toBe(201);
    expect(newMessages(b)).toBe(1);
    // Carol isn't in the DM: her subscribe was refused.
    expect(newMessages(c)).toBe(0);

    const leave = await app.inject({
      method: 'POST',
      url: `/dms/${dmId}/leave`,
      headers: { cookie: bob.cookie },
    });
    expect(leave.statusCode).toBe(200);
    await settle();
    expect(b.got).toContainEqual({ type: 'dm:removed', payload: { dmId } });
    expect(a.got.some((m) => m.type === 'dm:left' && m.payload.dmId === dmId)).toBe(true);

    // Anything broadcast to the DM now reaches alice and not bob, and
    // bob can't subscribe his way back in.
    b.ws.send(JSON.stringify({ type: 'channel:subscribe', payload: { channelId: dmId } }));
    await settle();
    const before = { a: a.got.length, b: b.got.length };
    app.broadcastToChannel(dmId, {
      type: 'message:deleted',
      payload: { messageId: 'x', channelId: dmId },
    });
    await settle();
    expect(a.got.length).toBe(before.a + 1);
    expect(b.got.length).toBe(before.b);

    // And alice can't post into a DM with nobody else in it.
    expect(await send('two')).toBe(403);
  });
});
