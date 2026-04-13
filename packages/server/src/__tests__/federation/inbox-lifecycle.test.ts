// SPDX-License-Identifier: Hippocratic-3.0
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { createDb } from '../../db/index.ts';
import { eq, and } from 'drizzle-orm';
import { actors } from '../../db/schema/actors.ts';
import { objects } from '../../db/schema/objects.ts';
import { collectionItems } from '../../db/schema/collections.ts';
import { friendships } from '../../db/schema/friendships.ts';
import { reactions } from '../../db/schema/reactions.ts';
import { wikiPages } from '../../db/schema/wiki.ts';
import { events } from '../../db/schema/events.ts';
import { serverFiles } from '../../db/schema/files.ts';
import { deliveryQueue } from '../../db/schema/delivery-queue.ts';
import {
  createFederationTestApp,
  createTestUser,
  createRemoteActor,
  createTestServer,
  postToInbox,
  cleanDb,
  testConfig,
} from './helpers.ts';

let app: FastifyInstance;
let db: ReturnType<typeof createDb>;

beforeAll(async () => {
  const result = await createFederationTestApp();
  app = result.app;
  db = result.db;
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await cleanDb(db);
});

describe('Follow lifecycle', () => {
  it('Person→Person Follow creates a pending_in friendship', async () => {
    const { body: alice } = await createTestUser(app, 'alice');
    const { actor: bob, privateKeyPem } = await createRemoteActor(db, {
      username: 'bob',
      domain: 'remote.tower',
    });

    const res = await postToInbox(app, '/users/alice/inbox', {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${bob.uri}/activities/follow-1`,
      type: 'Follow',
      actor: bob.uri,
      object: `http://test.babelr.local/users/alice`,
    }, bob.uri, privateKeyPem);

    expect(res.statusCode).toBe(202);

    // Check friendship was created
    const [friendship] = await db
      .select()
      .from(friendships)
      .where(eq(friendships.ownerActorId, alice.id));

    expect(friendship).toBeDefined();
    expect(friendship.state).toBe('pending_in');
    expect(friendship.otherActorId).toBe(bob.id);
  });

  it('Group Follow adds member and enqueues Accept', async () => {
    const { cookie } = await createTestUser(app, 'admin');
    const { server } = await createTestServer(app, cookie, 'Test Server');
    const { actor: bob, privateKeyPem } = await createRemoteActor(db, {
      username: 'bob',
      domain: 'remote.tower',
    });

    // Get the server's Group actor
    const [group] = await db
      .select()
      .from(actors)
      .where(eq(actors.id, server.id));

    // Find the slug from the group's URI
    const slug = group.preferredUsername;

    const res = await postToInbox(app, `/groups/${slug}/inbox`, {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${bob.uri}/activities/follow-1`,
      type: 'Follow',
      actor: bob.uri,
      object: group.uri,
    }, bob.uri, privateKeyPem);

    expect(res.statusCode).toBe(202);

    // Check membership was added to followers collection
    const [membership] = await db
      .select()
      .from(collectionItems)
      .where(
        and(
          eq(collectionItems.collectionUri, group.followersUri!),
          eq(collectionItems.itemUri, bob.uri),
        ),
      );

    expect(membership).toBeDefined();

    // Check Accept was enqueued
    const [delivery] = await db
      .select()
      .from(deliveryQueue)
      .where(eq(deliveryQueue.recipientInboxUri, bob.inboxUri));

    expect(delivery).toBeDefined();
    const activity = delivery.activityJson as Record<string, unknown>;
    expect(activity.type).toBe('Accept');
  });

  it('rejects activities from blocked domains in allowlist mode', async () => {
    const { body: alice } = await createTestUser(app, 'alice');
    const { actor: eve, privateKeyPem } = await createRemoteActor(db, {
      username: 'eve',
      domain: 'evil.tower',
    });

    // Temporarily switch to allowlist mode
    const origMode = testConfig.federationMode;
    const origDomains = testConfig.federationDomains;
    testConfig.federationMode = 'allowlist';
    testConfig.federationDomains = ['trusted.tower'];

    try {
      const res = await postToInbox(app, '/users/alice/inbox', {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${eve.uri}/activities/follow-1`,
        type: 'Follow',
        actor: eve.uri,
        object: `http://test.babelr.local/users/alice`,
      }, eve.uri, privateKeyPem);

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('domain not allowed');
    } finally {
      testConfig.federationMode = origMode;
      testConfig.federationDomains = origDomains;
    }
  });
});

describe('Create activities', () => {
  it('Create(Note) creates a shadow message in a Group channel', async () => {
    const { cookie } = await createTestUser(app, 'admin');
    const { server, channel } = await createTestServer(app, cookie, 'Test Server');
    const { actor: bob, privateKeyPem } = await createRemoteActor(db, {
      username: 'bob',
      domain: 'remote.tower',
    });

    // Add bob as a follower of the Group
    const [group] = await db.select().from(actors).where(eq(actors.id, server.id));
    await db.insert(collectionItems).values({
      collectionUri: group.followersUri!,
      itemUri: bob.uri,
      itemId: bob.id,
    });

    // Get channel URI
    const [ch] = await db.select().from(objects).where(eq(objects.id, channel.id));

    const noteUri = `${bob.uri}/notes/test-note-1`;
    const res = await postToInbox(app, `/groups/${group.preferredUsername}/inbox`, {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${bob.uri}/activities/create-1`,
      type: 'Create',
      actor: bob.uri,
      object: {
        id: noteUri,
        type: 'Note',
        attributedTo: bob.uri,
        content: 'Hello from remote!',
        context: ch.uri,
        published: new Date().toISOString(),
      },
      to: [group.followersUri],
    }, bob.uri, privateKeyPem);

    expect(res.statusCode).toBe(202);

    // Check shadow Note was created
    const [note] = await db
      .select()
      .from(objects)
      .where(eq(objects.uri, noteUri));

    expect(note).toBeDefined();
    expect(note.content).toBe('Hello from remote!');
    expect(note.type).toBe('Note');
  });

  it('Create(Article) creates a shadow wiki page', async () => {
    const { cookie } = await createTestUser(app, 'admin');
    const { server } = await createTestServer(app, cookie, 'Test Server');
    const { actor: bob, privateKeyPem } = await createRemoteActor(db, {
      username: 'bob',
      domain: 'remote.tower',
    });

    const [group] = await db.select().from(actors).where(eq(actors.id, server.id));
    await db.insert(collectionItems).values({
      collectionUri: group.followersUri!,
      itemUri: bob.uri,
      itemId: bob.id,
    });

    const articleUri = `http://remote.tower/wiki/test-page`;
    const res = await postToInbox(app, `/groups/${group.preferredUsername}/inbox`, {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${bob.uri}/activities/create-article-1`,
      type: 'Create',
      actor: bob.uri,
      object: {
        id: articleUri,
        type: 'Article',
        attributedTo: bob.uri,
        context: group.uri,
        name: 'Remote Wiki Page',
        content: '# Hello\nThis is a remote wiki page.',
        url: articleUri,
        slug: 'remote-page',
        tags: ['docs'],
      },
    }, bob.uri, privateKeyPem);

    expect(res.statusCode).toBe(202);

    // Check shadow wiki page was created
    const [page] = await db
      .select()
      .from(wikiPages)
      .where(eq(wikiPages.uri, articleUri));

    expect(page).toBeDefined();
    expect(page.title).toBe('Remote Wiki Page');
    expect(page.slug).toBe('remote-page');
  });

  it('Create(Event) creates a shadow calendar event', async () => {
    const { cookie } = await createTestUser(app, 'admin');
    const { server } = await createTestServer(app, cookie, 'Test Server');
    const { actor: bob, privateKeyPem } = await createRemoteActor(db, {
      username: 'bob',
      domain: 'remote.tower',
    });

    const [group] = await db.select().from(actors).where(eq(actors.id, server.id));
    await db.insert(collectionItems).values({
      collectionUri: group.followersUri!,
      itemUri: bob.uri,
      itemId: bob.id,
    });

    const eventUri = `http://remote.tower/events/test-event`;
    const startTime = new Date(Date.now() + 86400000).toISOString();
    const endTime = new Date(Date.now() + 90000000).toISOString();

    const res = await postToInbox(app, `/groups/${group.preferredUsername}/inbox`, {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${bob.uri}/activities/create-event-1`,
      type: 'Create',
      actor: bob.uri,
      object: {
        id: eventUri,
        type: 'Event',
        attributedTo: bob.uri,
        context: group.uri,
        name: 'Remote Standup',
        content: 'Daily standup meeting',
        startTime,
        endTime,
        location: 'Remote',
      },
    }, bob.uri, privateKeyPem);

    expect(res.statusCode).toBe(202);

    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.uri, eventUri));

    expect(event).toBeDefined();
    expect(event.title).toBe('Remote Standup');
  });

  it('Create(Document) creates a shadow file', async () => {
    const { cookie } = await createTestUser(app, 'admin');
    const { server } = await createTestServer(app, cookie, 'Test Server');
    const { actor: bob, privateKeyPem } = await createRemoteActor(db, {
      username: 'bob',
      domain: 'remote.tower',
    });

    const [group] = await db.select().from(actors).where(eq(actors.id, server.id));
    await db.insert(collectionItems).values({
      collectionUri: group.followersUri!,
      itemUri: bob.uri,
      itemId: bob.id,
    });

    const docUri = `http://remote.tower/files/test-doc`;
    const res = await postToInbox(app, `/groups/${group.preferredUsername}/inbox`, {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${bob.uri}/activities/create-doc-1`,
      type: 'Create',
      actor: bob.uri,
      object: {
        id: docUri,
        type: 'Document',
        attributedTo: bob.uri,
        context: group.uri,
        name: 'Design Spec',
        filename: 'design-spec.pdf',
        contentType: 'application/pdf',
        storageUrl: 'http://remote.tower/uploads/design-spec.pdf',
        description: 'Design specification document',
        slug: 'abc123',
      },
    }, bob.uri, privateKeyPem);

    expect(res.statusCode).toBe(202);

    const [file] = await db
      .select()
      .from(serverFiles)
      .where(eq(serverFiles.slug, 'abc123'));

    expect(file).toBeDefined();
    expect(file.filename).toBe('design-spec.pdf');
    expect(file.contentType).toBe('application/pdf');
  });
});

describe('Update activities', () => {
  it('Update(Person) updates a remote actor profile', async () => {
    const { actor: bob, privateKeyPem } = await createRemoteActor(db, {
      username: 'bob',
      domain: 'remote.tower',
      displayName: 'Bob Original',
    });

    // Need a local user to receive the update
    await createTestUser(app, 'alice');

    const res = await postToInbox(app, '/inbox', {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${bob.uri}/activities/update-1`,
      type: 'Update',
      actor: bob.uri,
      object: {
        id: bob.uri,
        type: 'Person',
        preferredUsername: 'bob',
        name: 'Bob Updated',
        summary: 'New bio',
      },
    }, bob.uri, privateKeyPem);

    expect(res.statusCode).toBe(202);

    // Check actor was updated
    const [updated] = await db
      .select()
      .from(actors)
      .where(eq(actors.id, bob.id));

    expect(updated.displayName).toBe('Bob Updated');
    expect(updated.summary).toBe('New bio');
  });

  it('Update(Note) updates message content', async () => {
    const { cookie } = await createTestUser(app, 'admin');
    const { server, channel } = await createTestServer(app, cookie, 'Test Server');
    const { actor: bob, privateKeyPem } = await createRemoteActor(db, {
      username: 'bob',
      domain: 'remote.tower',
    });

    const [group] = await db.select().from(actors).where(eq(actors.id, server.id));
    await db.insert(collectionItems).values({
      collectionUri: group.followersUri!,
      itemUri: bob.uri,
      itemId: bob.id,
    });

    // First create a message
    const [ch] = await db.select().from(objects).where(eq(objects.id, channel.id));
    const noteUri = `${bob.uri}/notes/edit-test`;
    await db.insert(objects).values({
      uri: noteUri,
      type: 'Note',
      content: 'Original content',
      context: ch.id,
      attributedTo: bob.id,
    });

    const res = await postToInbox(app, `/groups/${group.preferredUsername}/inbox`, {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${bob.uri}/activities/update-note-1`,
      type: 'Update',
      actor: bob.uri,
      object: {
        id: noteUri,
        type: 'Note',
        attributedTo: bob.uri,
        content: 'Edited content',
      },
    }, bob.uri, privateKeyPem);

    expect(res.statusCode).toBe(202);

    const [updated] = await db.select().from(objects).where(eq(objects.uri, noteUri));
    expect(updated.content).toBe('Edited content');
  });
});

describe('Delete activities', () => {
  it('Delete removes a shadow Note', async () => {
    const { cookie } = await createTestUser(app, 'admin');
    const { server, channel } = await createTestServer(app, cookie, 'Test Server');
    const { actor: bob, privateKeyPem } = await createRemoteActor(db, {
      username: 'bob',
      domain: 'remote.tower',
    });

    const [group] = await db.select().from(actors).where(eq(actors.id, server.id));
    await db.insert(collectionItems).values({
      collectionUri: group.followersUri!,
      itemUri: bob.uri,
      itemId: bob.id,
    });

    // Create a message to delete
    const [ch] = await db.select().from(objects).where(eq(objects.id, channel.id));
    const noteUri = `${bob.uri}/notes/delete-test`;
    await db.insert(objects).values({
      uri: noteUri,
      type: 'Note',
      content: 'To be deleted',
      context: ch.id,
      attributedTo: bob.id,
    });

    const res = await postToInbox(app, `/groups/${group.preferredUsername}/inbox`, {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${bob.uri}/activities/delete-1`,
      type: 'Delete',
      actor: bob.uri,
      object: noteUri,
    }, bob.uri, privateKeyPem);

    expect(res.statusCode).toBe(202);

    // Message should be tombstoned (content cleared)
    const [deleted] = await db.select().from(objects).where(eq(objects.uri, noteUri));
    expect(deleted.type).toBe('Tombstone');
  });
});

describe('Like / Undo(Like)', () => {
  it('Like creates a reaction on a Note', async () => {
    const { cookie } = await createTestUser(app, 'admin');
    const { server, channel } = await createTestServer(app, cookie, 'Test Server');
    const { actor: bob, privateKeyPem } = await createRemoteActor(db, {
      username: 'bob',
      domain: 'remote.tower',
    });

    const [group] = await db.select().from(actors).where(eq(actors.id, server.id));
    await db.insert(collectionItems).values({
      collectionUri: group.followersUri!,
      itemUri: bob.uri,
      itemId: bob.id,
    });

    // Create a message to react to
    const [ch] = await db.select().from(objects).where(eq(objects.id, channel.id));
    const noteUri = `http://test.babelr.local/notes/react-test`;
    const [note] = await db.insert(objects).values({
      uri: noteUri,
      type: 'Note',
      content: 'React to me',
      context: ch.id,
      attributedTo: bob.id,
    }).returning();

    const res = await postToInbox(app, `/groups/${group.preferredUsername}/inbox`, {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${bob.uri}/activities/like-1`,
      type: 'Like',
      actor: bob.uri,
      object: {
        id: noteUri,
        actor: bob.uri,
        emoji: '👍',
      },
    }, bob.uri, privateKeyPem);

    expect(res.statusCode).toBe(202);

    const [reaction] = await db
      .select()
      .from(reactions)
      .where(eq(reactions.objectId, note.id));

    expect(reaction).toBeDefined();
    expect(reaction.emoji).toBe('👍');
    expect(reaction.actorId).toBe(bob.id);
  });

  it('Undo(Like) removes a reaction', async () => {
    const { cookie } = await createTestUser(app, 'admin');
    const { server, channel } = await createTestServer(app, cookie, 'Test Server');
    const { actor: bob, privateKeyPem } = await createRemoteActor(db, {
      username: 'bob',
      domain: 'remote.tower',
    });

    const [group] = await db.select().from(actors).where(eq(actors.id, server.id));
    await db.insert(collectionItems).values({
      collectionUri: group.followersUri!,
      itemUri: bob.uri,
      itemId: bob.id,
    });

    // Create message + reaction
    const [ch] = await db.select().from(objects).where(eq(objects.id, channel.id));
    const noteUri = `http://test.babelr.local/notes/undo-react-test`;
    const [note] = await db.insert(objects).values({
      uri: noteUri,
      type: 'Note',
      content: 'React then undo',
      context: ch.id,
      attributedTo: bob.id,
    }).returning();

    await db.insert(reactions).values({
      objectId: note.id,
      actorId: bob.id,
      emoji: '👍',
    });

    const res = await postToInbox(app, `/groups/${group.preferredUsername}/inbox`, {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${bob.uri}/activities/undo-like-1`,
      type: 'Undo',
      actor: bob.uri,
      object: {
        type: 'Like',
        actor: bob.uri,
        object: { id: noteUri, emoji: '👍' },
      },
    }, bob.uri, privateKeyPem);

    expect(res.statusCode).toBe(202);

    const remaining = await db
      .select()
      .from(reactions)
      .where(eq(reactions.objectId, note.id));

    expect(remaining).toHaveLength(0);
  });
});

describe('Undo(Follow)', () => {
  it('Undo(Follow) removes a Group follower', async () => {
    const { cookie } = await createTestUser(app, 'admin');
    const { server } = await createTestServer(app, cookie, 'Test Server');
    const { actor: bob, privateKeyPem } = await createRemoteActor(db, {
      username: 'bob',
      domain: 'remote.tower',
    });

    const [group] = await db.select().from(actors).where(eq(actors.id, server.id));
    // Add bob as a follower
    await db.insert(collectionItems).values({
      collectionUri: group.followersUri!,
      itemUri: bob.uri,
      itemId: bob.id,
    });

    const res = await postToInbox(app, `/groups/${group.preferredUsername}/inbox`, {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${bob.uri}/activities/undo-follow-1`,
      type: 'Undo',
      actor: bob.uri,
      object: {
        type: 'Follow',
        actor: bob.uri,
        object: group.uri,
      },
    }, bob.uri, privateKeyPem);

    expect(res.statusCode).toBe(202);

    const remaining = await db
      .select()
      .from(collectionItems)
      .where(
        and(
          eq(collectionItems.collectionUri, group.followersUri!),
          eq(collectionItems.itemUri, bob.uri),
        ),
      );

    expect(remaining).toHaveLength(0);
  });
});
