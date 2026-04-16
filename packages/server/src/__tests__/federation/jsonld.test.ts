// SPDX-License-Identifier: Hippocratic-3.0
import { describe, it, expect } from 'vitest';
import {
  AP_CONTEXT,
  serializeActor,
  serializeNote,
  serializeActivity,
  serializeOrderedCollection,
  serializeOrderedCollectionPage,
} from '../../federation/jsonld.ts';

const mockActor = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  uri: 'https://test.babelr.local/users/alice',
  type: 'Person' as const,
  preferredUsername: 'alice',
  displayName: 'Alice',
  summary: 'Test user',
  email: 'alice@test.local',
  passwordHash: 'hash',
  privateKeyPem: null,
  inboxUri: 'https://test.babelr.local/users/alice/inbox',
  outboxUri: 'https://test.babelr.local/users/alice/outbox',
  followersUri: 'https://test.babelr.local/users/alice/followers',
  followingUri: 'https://test.babelr.local/users/alice/following',
  preferredLanguage: 'en',
  properties: { apPublicKey: { id: 'https://test.babelr.local/users/alice#main-key', owner: 'https://test.babelr.local/users/alice', publicKeyPem: '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----' } },
  local: true,
  emailVerified: true,
  verificationToken: null,
  verificationTokenExpires: null,
  totpSecret: null,
  totpEnabled: false,
  totpRecoveryCodes: [],
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

const mockNote = {
  id: '660e8400-e29b-41d4-a716-446655440001',
  uri: 'https://test.babelr.local/objects/test-note',
  type: 'Note' as const,
  attributedTo: '550e8400-e29b-41d4-a716-446655440000',
  content: 'Hello, world!',
  contentMap: null,
  mediaType: 'text/plain',
  source: null,
  inReplyTo: null,
  context: null,
  to: ['https://www.w3.org/ns/activitystreams#Public'],
  cc: [],
  belongsTo: null,
  properties: {},
  slug: null,
  published: new Date('2026-01-01T12:00:00Z'),
  updated: null,
  contentSearch: '',
};

describe('JSON-LD Serialization', () => {
  it('serializes an Actor with AP context', () => {
    const result = serializeActor(mockActor);

    expect(result['@context']).toEqual(AP_CONTEXT);
    expect(result.id).toBe('https://test.babelr.local/users/alice');
    expect(result.type).toBe('Person');
    expect(result.preferredUsername).toBe('alice');
    expect(result.name).toBe('Alice');
    expect(result.inbox).toBe('https://test.babelr.local/users/alice/inbox');
    expect(result.outbox).toBe('https://test.babelr.local/users/alice/outbox');
    expect(result.publicKey).toBeTruthy();
    expect((result.publicKey as Record<string, unknown>).publicKeyPem).toContain('BEGIN PUBLIC KEY');
  });

  it('serializes a Note', () => {
    const result = serializeNote(mockNote, 'https://test.babelr.local/users/alice');

    expect(result['@context']).toEqual(AP_CONTEXT);
    expect(result.id).toBe('https://test.babelr.local/objects/test-note');
    expect(result.type).toBe('Note');
    expect(result.attributedTo).toBe('https://test.babelr.local/users/alice');
    expect(result.content).toBe('Hello, world!');
    expect(result.published).toBe('2026-01-01T12:00:00.000Z');
    expect(result.to).toContain('https://www.w3.org/ns/activitystreams#Public');
  });

  it('serializes an Activity', () => {
    const noteJson = serializeNote(mockNote, 'https://test.babelr.local/users/alice');
    const result = serializeActivity(
      'https://test.babelr.local/activities/123',
      'Create',
      'https://test.babelr.local/users/alice',
      noteJson,
      ['https://www.w3.org/ns/activitystreams#Public'],
      [],
    );

    expect(result['@context']).toEqual(AP_CONTEXT);
    expect(result.type).toBe('Create');
    expect(result.actor).toBe('https://test.babelr.local/users/alice');
    expect((result.object as Record<string, unknown>).type).toBe('Note');
  });

  it('serializes an OrderedCollection', () => {
    const result = serializeOrderedCollection(
      'https://test.babelr.local/users/alice/outbox',
      42,
      'https://test.babelr.local/users/alice/outbox?page=1',
    );

    expect(result.type).toBe('OrderedCollection');
    expect(result.totalItems).toBe(42);
    expect(result.first).toBe('https://test.babelr.local/users/alice/outbox?page=1');
  });

  it('serializes an OrderedCollectionPage', () => {
    const result = serializeOrderedCollectionPage(
      'https://test.babelr.local/users/alice/outbox?page=1',
      [{ id: 'item1' }, { id: 'item2' }],
      'https://test.babelr.local/users/alice/outbox',
    );

    expect(result.type).toBe('OrderedCollectionPage');
    expect(result.partOf).toBe('https://test.babelr.local/users/alice/outbox');
    expect(result.orderedItems).toHaveLength(2);
  });
});
