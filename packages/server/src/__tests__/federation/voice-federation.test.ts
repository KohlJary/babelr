// SPDX-License-Identifier: Hippocratic-3.0
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type Fastify from 'fastify';
import { eq } from 'drizzle-orm';
import {
  createFederationTestApp,
  createTestUser,
  createTestServer,
  createRemoteActor,
  cleanDb,
  testConfig,
} from './helpers.ts';
import { actors } from '../../db/schema/actors.ts';
import { objects } from '../../db/schema/objects.ts';
import { collectionItems } from '../../db/schema/collections.ts';
import { signRequest } from '../../federation/signatures.ts';
import { verifyVoiceFederationToken } from '../../voice/federation-jwt.ts';
import type { createDb } from '../../db/index.ts';

/**
 * Federated voice handshake integration tests. Boots Tower A (the
 * federation test app); Tower B is simulated by `createRemoteActor`
 * which gives us a remote actor record + private key we can sign with,
 * just like the real inbox tests do.
 *
 * We then exercise POST /api/voice/federation-token end-to-end:
 * signature verification, federation policy gate, voice-channel check,
 * CONNECT_VOICE membership check, JWT issuance.
 */

let app: Awaited<ReturnType<typeof Fastify>>;
let db: ReturnType<typeof createDb>;

beforeAll(async () => {
  const setup = await createFederationTestApp();
  app = setup.app;
  db = setup.db;
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await cleanDb(db);
});

async function setupGroupWithVoiceChannel(opts: {
  ownerUsername: string;
  serverName: string;
  channelName: string;
}) {
  const owner = await createTestUser(app, opts.ownerUsername);
  const { server, channel } = await createTestServer(app, owner.cookie, opts.serverName);
  // Create a voice channel inside the same server.
  const res = await app.inject({
    method: 'POST',
    url: `/servers/${server.id}/channels`,
    headers: { cookie: owner.cookie },
    payload: { name: opts.channelName, channelType: 'voice' },
  });
  expect(res.statusCode).toBe(201);
  const voiceChannel = JSON.parse(res.body);
  // Inferred default text channel returned by createTestServer not used.
  void channel;
  return { owner, server, voiceChannel };
}

async function postFederationToken(opts: {
  channelUri: string;
  signerUri: string;
  signerPrivateKey: string;
}) {
  const body = JSON.stringify({ channelUri: opts.channelUri });
  const url = `http://${testConfig.domain}/voice/federation-token`;
  const { headers } = signRequest(
    opts.signerPrivateKey,
    `${opts.signerUri}#main-key`,
    'POST',
    url,
    body,
  );
  return app.inject({
    method: 'POST',
    url: '/voice/federation-token',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    payload: body,
  });
}

describe('federated voice token issuance', () => {
  it('issues a JWT to a remote member of the channel\'s Group', async () => {
    const { server, voiceChannel } = await setupGroupWithVoiceChannel({
      ownerUsername: 'alice',
      serverName: 'TestServer',
      channelName: 'voice-room',
    });

    const { actor: alice, privateKeyPem } = await createRemoteActor(db, {
      username: 'alice-remote',
      domain: 'tower-b.example.com',
    });

    // Make alice a member of the Group's followers collection — this is
    // how federated membership is represented post-Add(actor, Group).
    const [group] = await db.select().from(actors).where(eq(actors.id, server.id));
    await db.insert(collectionItems).values({
      collectionUri: group.followersUri!,
      itemUri: alice.uri,
      itemId: alice.id,
    });

    const res = await postFederationToken({
      channelUri: voiceChannel.uri,
      signerUri: alice.uri,
      signerPrivateKey: privateKeyPem,
    });

    expect(res.statusCode).toBe(200);
    const reply = JSON.parse(res.body);
    expect(typeof reply.token).toBe('string');
    expect(reply.wsUrl).toContain(testConfig.domain);
    expect(reply.channelId).toBe(voiceChannel.id);
    expect(reply.expiresIn).toBe(300);

    const claims = verifyVoiceFederationToken(reply.token, testConfig.sessionSecret);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe(alice.uri);
    expect(claims!.channelId).toBe(voiceChannel.id);
    expect(claims!.iss).toBe(testConfig.domain);
  });

  it('rejects a remote actor who is not a member of the Group', async () => {
    const { voiceChannel } = await setupGroupWithVoiceChannel({
      ownerUsername: 'alice',
      serverName: 'TestServer',
      channelName: 'voice-room',
    });

    const { actor: stranger, privateKeyPem } = await createRemoteActor(db, {
      username: 'stranger',
      domain: 'tower-b.example.com',
    });

    const res = await postFederationToken({
      channelUri: voiceChannel.uri,
      signerUri: stranger.uri,
      signerPrivateKey: privateKeyPem,
    });

    expect(res.statusCode).toBe(403);
  });

  it('rejects requests for a non-voice channel', async () => {
    const owner = await createTestUser(app, 'alice');
    const { channel: textChannel } = await createTestServer(app, owner.cookie, 'TextOnly');
    const { actor: alice, privateKeyPem } = await createRemoteActor(db, {
      username: 'alice-remote',
      domain: 'tower-b.example.com',
    });

    const res = await postFederationToken({
      channelUri: textChannel.uri,
      signerUri: alice.uri,
      signerPrivateKey: privateKeyPem,
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/voice/i);
  });

  it('rejects requests with no signature', async () => {
    const { voiceChannel } = await setupGroupWithVoiceChannel({
      ownerUsername: 'alice',
      serverName: 'TestServer',
      channelName: 'voice-room',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/voice/federation-token',
      headers: { 'Content-Type': 'application/json' },
      payload: JSON.stringify({ channelUri: voiceChannel.uri }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects when the channel is unknown', async () => {
    const { actor: alice, privateKeyPem } = await createRemoteActor(db, {
      username: 'alice-remote',
      domain: 'tower-b.example.com',
    });
    const res = await postFederationToken({
      channelUri: `http://${testConfig.domain}/channels/does-not-exist`,
      signerUri: alice.uri,
      signerPrivateKey: privateKeyPem,
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects local actors (origin endpoint is for federated peers only)', async () => {
    const { voiceChannel } = await setupGroupWithVoiceChannel({
      ownerUsername: 'alice',
      serverName: 'TestServer',
      channelName: 'voice-room',
    });
    // Build a "local actor with keys" that signs against ourselves.
    // Using createRemoteActor and then flipping local=true mimics the
    // edge case: a local user trying to use the federated endpoint.
    const { actor: bob, privateKeyPem } = await createRemoteActor(db, {
      username: 'bob-local',
      domain: testConfig.domain,
    });
    await db.update(actors).set({ local: true }).where(eq(actors.id, bob.id));

    const res = await postFederationToken({
      channelUri: voiceChannel.uri,
      signerUri: bob.uri,
      signerPrivateKey: privateKeyPem,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/Local actor/);
  });
});

describe('voice channel ownership checks', () => {
  it('refuses to issue a token for a federated/remote channel', async () => {
    // Create a remote Group + voice channel cached locally (we'd be the
    // home Tower in this scenario; some other Tower owns the channel).
    const { actor: remoteGroup } = await createRemoteActor(db, {
      username: 'remote-group',
      domain: 'tower-a.example.com',
      type: 'Group',
    });
    const remoteChannelUri = `http://tower-a.example.com/objects/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`;
    await db.insert(objects).values({
      type: 'Group',
      belongsTo: remoteGroup.id,
      uri: remoteChannelUri,
      properties: { name: 'remote-voice', channelType: 'voice' },
    });

    const { actor: alice, privateKeyPem } = await createRemoteActor(db, {
      username: 'alice',
      domain: 'tower-b.example.com',
    });

    const res = await postFederationToken({
      channelUri: remoteChannelUri,
      signerUri: alice.uri,
      signerPrivateKey: privateKeyPem,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/not owned/i);
  });
});
