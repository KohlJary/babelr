// SPDX-License-Identifier: Hippocratic-3.0
import { eq } from 'drizzle-orm';
import { actors } from '../db/schema/actors.ts';
import { objects } from '../db/schema/objects.ts';
import type { Database } from '../db/index.ts';

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT = 10_000;
const USER_AGENT = 'Babelr/0.1.0';

function extractIconUrl(icon: unknown): string | null {
  if (!icon) return null;
  if (typeof icon === 'string') return icon;
  if (typeof icon === 'object') {
    const i = icon as { url?: unknown; href?: unknown };
    if (typeof i.url === 'string') return i.url;
    if (typeof i.href === 'string') return i.href;
  }
  return null;
}

async function fetchAP(uri: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(uri, {
      headers: {
        Accept: 'application/activity+json, application/ld+json',
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });

    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function resolveActor(
  db: Database,
  uri: string,
): Promise<typeof actors.$inferSelect | null> {
  // Check local cache first
  const [existing] = await db.select().from(actors).where(eq(actors.uri, uri)).limit(1);

  if (existing) {
    // If local actor, always return
    if (existing.local) return existing;

    // If remote and not stale, return cached
    const age = Date.now() - existing.updatedAt.getTime();
    if (age < STALE_THRESHOLD_MS) return existing;
  }

  // Fetch from remote
  const data = await fetchAP(uri);
  if (!data || !data.id || !data.inbox) return existing ?? null;

  const values = {
    uri: data.id as string,
    type: (data.type as string) ?? 'Person',
    preferredUsername: (data.preferredUsername as string) ?? 'unknown',
    displayName: (data.name as string) ?? null,
    summary: (data.summary as string) ?? null,
    inboxUri: data.inbox as string,
    outboxUri: (data.outbox as string) ?? `${data.id}/outbox`,
    followersUri: (data.followers as string) ?? null,
    followingUri: (data.following as string) ?? null,
    local: false,
    properties: {
      ...(data.publicKey ? { apPublicKey: data.publicKey } : {}),
      ...(data.babelrEcdhKey ? { publicKey: data.babelrEcdhKey } : {}),
      ...(extractIconUrl(data.icon) ? { avatarUrl: extractIconUrl(data.icon) } : {}),
    },
    updatedAt: new Date(),
  };

  if (existing) {
    const [updated] = await db
      .update(actors)
      .set(values)
      .where(eq(actors.id, existing.id))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(actors)
    .values(values)
    .returning();
  return created;
}

/**
 * Look up a remote actor by `user@domain` handle via WebFinger.
 * Returns the cached local actor row (creating or refreshing as needed).
 */
export async function lookupActorByHandle(
  db: Database,
  handle: string,
): Promise<typeof actors.$inferSelect | null> {
  const match = handle.match(/^@?([^@\s]+)@([^@\s]+)$/);
  if (!match) return null;
  const [, username, domain] = match;

  const webfingerUri = `https://${domain}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${username}@${domain}`)}`;

  try {
    const res = await fetch(webfingerUri, {
      headers: { Accept: 'application/jrd+json, application/json', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) return null;
    const jrd = (await res.json()) as { links?: Array<{ rel?: string; type?: string; href?: string }> };
    const self = jrd.links?.find(
      (l) => l.rel === 'self' && (l.type === 'application/activity+json' || l.type === 'application/ld+json'),
    );
    if (!self?.href) return null;
    return resolveActor(db, self.href);
  } catch {
    return null;
  }
}

export async function resolveActorByKeyId(
  db: Database,
  keyId: string,
): Promise<typeof actors.$inferSelect | null> {
  // Key ID is typically actorUri#main-key — strip the fragment
  const actorUri = keyId.split('#')[0];
  return resolveActor(db, actorUri);
}

export async function resolveObject(
  db: Database,
  uri: string,
): Promise<typeof objects.$inferSelect | null> {
  const [existing] = await db.select().from(objects).where(eq(objects.uri, uri)).limit(1);
  if (existing) return existing;

  const data = await fetchAP(uri);
  if (!data || !data.id) return null;

  // Resolve the author if present
  let authorId: string | null = null;
  if (data.attributedTo) {
    const author = await resolveActor(db, data.attributedTo as string);
    if (author) authorId = author.id;
  }

  const [created] = await db
    .insert(objects)
    .values({
      uri: data.id as string,
      type: (data.type as string) ?? 'Note',
      attributedTo: authorId,
      content: (data.content as string) ?? null,
      mediaType: (data.mediaType as string) ?? 'text/html',
      to: (data.to as string[]) ?? [],
      cc: (data.cc as string[]) ?? [],
      published: data.published ? new Date(data.published as string) : new Date(),
    })
    .returning();

  return created;
}
