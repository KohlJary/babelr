// SPDX-License-Identifier: Hippocratic-3.0
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp, createTestUser, cleanDb, wsSent } from '../helpers.ts';
import type Fastify from 'fastify';
import type { createDb } from '../../db/index.ts';
import { enc } from '../e2e-fixtures.ts';

/**
 * Agent reply status: an agent marks the message it's answering as
 * working / failed / done; the message's author can ask for a retry.
 */

let app: ReturnType<typeof Fastify>;
let db: ReturnType<typeof createDb>;

beforeAll(async () => {
  const result = await createTestApp();
  app = result.app;
  db = result.db;
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await cleanDb(db);
  wsSent.length = 0;
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function createAgent(cookie: string, username: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/agents',
    headers: { cookie },
    payload: { username, kind: 'agent', displayName: username, dmPolicy: 'anyone' },
  });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body) as { id: string };
}

async function mint(cookie: string, agentId: string, scopes: string[]) {
  const res = await app.inject({
    method: 'POST',
    url: `/agents/${agentId}/tokens`,
    headers: { cookie },
    payload: { name: 'test', scopes },
  });
  expect(res.statusCode).toBe(201);
  return (JSON.parse(res.body) as { token: string }).token;
}

/** Kohl in a DM with agent robo, and one message from Kohl in it. */
async function dmWithAgent(scopes = ['dms:read', 'dms:post']) {
  const kohl = await createTestUser(app, 'kohl');
  const agent = await createAgent(kohl.cookie, 'robo');
  const token = await mint(kohl.cookie, agent.id, scopes);
  const dm = await app.inject({
    method: 'POST',
    url: '/dms',
    headers: { cookie: kohl.cookie },
    payload: { participantId: agent.id },
  });
  const dmId = JSON.parse(dm.body).id as string;
  const msg = await app.inject({
    method: 'POST',
    url: `/dms/${dmId}/messages`,
    headers: { cookie: kohl.cookie },
    payload: { content: 'ciphertext', properties: enc() },
  });
  expect(msg.statusCode).toBe(201);
  const messageId = JSON.parse(msg.body).message.id as string;
  return { kohl, agent, token, dmId, messageId };
}

function setStatus(token: string, channelId: string, messageId: string, body: unknown) {
  return app.inject({
    method: 'PUT',
    url: `/channels/${channelId}/messages/${messageId}/agent-status`,
    headers: bearer(token),
    payload: body as Record<string, unknown>,
  });
}

function retry(cookie: string, channelId: string, messageId: string, agentId: string) {
  return app.inject({
    method: 'POST',
    url: `/channels/${channelId}/messages/${messageId}/agent-status/${agentId}/retry`,
    headers: { cookie },
  });
}

async function statusOn(headers: Record<string, string>, dmId: string, messageId: string) {
  const res = await app.inject({ method: 'GET', url: `/dms/${dmId}/messages`, headers });
  const m = JSON.parse(res.body).messages.find(
    (x: { message: { id: string } }) => x.message.id === messageId,
  );
  return m.message.agentStatus as
    | Array<{ agent: { id: string; preferredUsername: string }; state: string; detail: string }>
    | undefined;
}

describe('agent reply status', () => {
  it('shows what the agent is doing on the message, live and in the history', async () => {
    const { kohl, agent, token, dmId, messageId } = await dmWithAgent();
    expect(await statusOn({ cookie: kohl.cookie }, dmId, messageId)).toBeUndefined();

    const res = await setStatus(token, dmId, messageId, { state: 'working' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ state: 'working', agent: { id: agent.id } });
    expect(wsSent.at(-1)).toMatchObject({
      to: `channel:${dmId}`,
      message: {
        type: 'agent-status:update',
        payload: { messageId, status: { state: 'working' } },
      },
    });

    await setStatus(token, dmId, messageId, { state: 'failed', detail: 'usage limit' });
    const seen = await statusOn({ cookie: kohl.cookie }, dmId, messageId);
    expect(seen).toHaveLength(1);
    expect(seen![0]).toMatchObject({
      state: 'failed',
      detail: 'usage limit',
      agent: { preferredUsername: 'robo' },
    });
  });

  it('the author asks for a retry; the agent sees it and answers', async () => {
    const { kohl, agent, token, dmId, messageId } = await dmWithAgent();
    await setStatus(token, dmId, messageId, { state: 'failed', detail: 'timeout' });

    const r = await retry(kohl.cookie, dmId, messageId, agent.id);
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ state: 'retry', detail: '' });
    expect(wsSent.at(-1)).toMatchObject({
      message: { type: 'agent-status:update', payload: { status: { state: 'retry' } } },
    });

    // The agent finds the retry in its own read of the DM.
    const asAgent = await statusOn(bearer(token), dmId, messageId);
    expect(asAgent![0].state).toBe('retry');

    await setStatus(token, dmId, messageId, { state: 'working' });
    await setStatus(token, dmId, messageId, { state: 'done' });
    // Nothing left to retry once it's answered.
    expect((await retry(kohl.cookie, dmId, messageId, agent.id)).statusCode).toBe(409);
  });

  it('a reply that never came (still working) can be retried; one never started cannot', async () => {
    const { kohl, agent, token, dmId, messageId } = await dmWithAgent();
    expect((await retry(kohl.cookie, dmId, messageId, agent.id)).statusCode).toBe(404);
    await setStatus(token, dmId, messageId, { state: 'working' });
    expect((await retry(kohl.cookie, dmId, messageId, agent.id)).statusCode).toBe(200);
  });

  it('only agents set status, only to their own states, within limits', async () => {
    const { kohl, token, dmId, messageId } = await dmWithAgent();
    const asPerson = await app.inject({
      method: 'PUT',
      url: `/channels/${dmId}/messages/${messageId}/agent-status`,
      headers: { cookie: kohl.cookie },
      payload: { state: 'working' },
    });
    expect(asPerson.statusCode).toBe(403);

    for (const body of [
      {},
      { state: 'retry' }, // the author's, not the agent's
      { state: 'thinking' },
      { state: 'failed', detail: 'x'.repeat(301) },
      { state: 'failed', detail: 42 },
    ]) {
      expect((await setStatus(token, dmId, messageId, body)).statusCode, JSON.stringify(body)).toBe(
        400,
      );
    }
  });

  it("an agent doesn't mark its own message", async () => {
    const { token, dmId } = await dmWithAgent();
    const own = await app.inject({
      method: 'POST',
      url: `/dms/${dmId}/messages`,
      headers: bearer(token),
      payload: { content: 'ciphertext', properties: enc() },
    });
    const ownId = JSON.parse(own.body).message.id;
    expect((await setStatus(token, dmId, ownId, { state: 'working' })).statusCode).toBe(400);
  });

  it('in a DM it needs dms:post; channels:post alone is refused', async () => {
    const { dmId, messageId, kohl, agent } = await dmWithAgent();
    const chOnly = await mint(kohl.cookie, agent.id, ['channels:read', 'channels:post']);
    expect((await setStatus(chOnly, dmId, messageId, { state: 'working' })).statusCode).toBe(403);
  });

  it("an agent's message can be retried by its sponsor", async () => {
    const kohl = await createTestUser(app, 'kohl');
    const runner = await createAgent(kohl.cookie, 'runner');
    const cass = await createAgent(kohl.cookie, 'cass2');
    const runnerTok = await mint(kohl.cookie, runner.id, ['channels:read', 'channels:post']);
    const cassTok = await mint(kohl.cookie, cass.id, ['channels:read', 'channels:post']);
    const s = await app.inject({
      method: 'POST',
      url: '/servers',
      headers: { cookie: kohl.cookie },
      payload: { name: 'H' },
    });
    const serverId = JSON.parse(s.body).id as string;
    const ch = await app.inject({
      method: 'GET',
      url: `/servers/${serverId}/channels`,
      headers: { cookie: kohl.cookie },
    });
    const channelId = JSON.parse(ch.body)[0].id as string;
    for (const agentId of [runner.id, cass.id]) {
      await app.inject({
        method: 'POST',
        url: `/servers/${serverId}/agents`,
        headers: { cookie: kohl.cookie },
        payload: { agentId },
      });
    }
    const msg = await app.inject({
      method: 'POST',
      url: `/channels/${channelId}/messages`,
      headers: bearer(runnerTok),
      payload: { content: '@cass2, your turn' },
    });
    const messageId = JSON.parse(msg.body).message.id as string;
    expect(
      (await setStatus(cassTok, channelId, messageId, { state: 'failed', detail: 'too long' }))
        .statusCode,
    ).toBe(200);
    expect((await retry(kohl.cookie, channelId, messageId, cass.id)).statusCode).toBe(200);
  });

  it('the agent cannot retry for the author, nor can anyone but the author', async () => {
    const kohl = await createTestUser(app, 'kohl');
    const bob = await createTestUser(app, 'bob');
    const agent = await createAgent(kohl.cookie, 'robo');
    const token = await mint(kohl.cookie, agent.id, ['channels:read', 'channels:post']);
    const s = await app.inject({
      method: 'POST',
      url: '/servers',
      headers: { cookie: kohl.cookie },
      payload: { name: 'House' },
    });
    const serverId = JSON.parse(s.body).id as string;
    const ch = await app.inject({
      method: 'GET',
      url: `/servers/${serverId}/channels`,
      headers: { cookie: kohl.cookie },
    });
    const channelId = JSON.parse(ch.body)[0].id as string;
    const add = await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/agents`,
      headers: { cookie: kohl.cookie },
      payload: { agentId: agent.id },
    });
    expect(add.statusCode).toBe(201);
    await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/join`,
      headers: { cookie: bob.cookie },
    });
    const msg = await app.inject({
      method: 'POST',
      url: `/channels/${channelId}/messages`,
      headers: { cookie: kohl.cookie },
      payload: { content: '@robo what next?' },
    });
    const messageId = JSON.parse(msg.body).message.id as string;

    // Works in a server channel with channels:post.
    expect((await setStatus(token, channelId, messageId, { state: 'failed' })).statusCode).toBe(
      200,
    );

    // Bob is in the channel but didn't write the message.
    expect((await retry(bob.cookie, channelId, messageId, agent.id)).statusCode).toBe(403);
    // Tokens never reach the retry route.
    const asAgent = await app.inject({
      method: 'POST',
      url: `/channels/${channelId}/messages/${messageId}/agent-status/${agent.id}/retry`,
      headers: bearer(token),
    });
    expect(asAgent.statusCode).toBe(403);
    expect((await retry(kohl.cookie, channelId, messageId, agent.id)).statusCode).toBe(200);
  });
});
