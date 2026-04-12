// SPDX-License-Identifier: Hippocratic-3.0
import { actors } from '../db/schema/actors.ts';
import { objects } from '../db/schema/objects.ts';

export const AP_CONTEXT = [
  'https://www.w3.org/ns/activitystreams',
  'https://w3id.org/security/v1',
  {
    babelr: 'https://babelr.chat/ns#',
    babelrEcdhKey: 'babelr:ecdhKey',
    babelrEncrypted: 'babelr:encrypted',
    babelrIv: 'babelr:iv',
    babelrAttachments: 'babelr:attachments',
  },
];

export function serializeActor(actor: typeof actors.$inferSelect) {
  const props = actor.properties as Record<string, unknown> | null;

  // Resolve relative icon path to absolute URL using the actor's own origin.
  // Person actors use `avatarUrl`; Group (server) actors use `logoUrl`.
  const rawIcon = (props?.logoUrl as string | undefined) ?? (props?.avatarUrl as string | undefined);
  let iconUrl: string | null = null;
  if (rawIcon) {
    if (rawIcon.startsWith('http://') || rawIcon.startsWith('https://')) {
      iconUrl = rawIcon;
    } else {
      try {
        const origin = new URL(actor.uri).origin;
        iconUrl = `${origin}${rawIcon.startsWith('/') ? '' : '/'}${rawIcon}`;
      } catch {
        iconUrl = null;
      }
    }
  }

  return {
    '@context': AP_CONTEXT,
    id: actor.uri,
    type: actor.type,
    preferredUsername: actor.preferredUsername,
    name: actor.displayName ?? actor.preferredUsername,
    summary: actor.summary ?? '',
    inbox: actor.inboxUri,
    outbox: actor.outboxUri,
    followers: actor.followersUri,
    following: actor.followingUri,
    ...(props?.apPublicKey ? { publicKey: props.apPublicKey } : {}),
    ...(props?.publicKey ? { babelrEcdhKey: props.publicKey } : {}),
    ...(iconUrl ? { icon: { type: 'Image', url: iconUrl } } : {}),
    url: actor.uri,
  };
}

export function serializeNote(
  obj: typeof objects.$inferSelect,
  actorUri: string,
  contextUri?: string,
) {
  const props = obj.properties as Record<string, unknown> | null;
  return {
    '@context': AP_CONTEXT,
    id: obj.uri,
    type: 'Note',
    attributedTo: actorUri,
    content: obj.content ?? '',
    published: obj.published.toISOString(),
    to: (obj.to as string[]) ?? ['https://www.w3.org/ns/activitystreams#Public'],
    cc: (obj.cc as string[]) ?? [],
    ...(contextUri ? { context: contextUri } : {}),
    ...(obj.mediaType && { mediaType: obj.mediaType }),
    ...(props?.encrypted ? { babelrEncrypted: true } : {}),
    ...(props?.iv ? { babelrIv: props.iv } : {}),
    ...(props?.attachments ? { babelrAttachments: props.attachments } : {}),
  };
}

export function serializeActivity(
  uri: string,
  type: string,
  actorUri: string,
  object: unknown,
  to: string[],
  cc: string[],
) {
  return {
    '@context': AP_CONTEXT,
    id: uri,
    type,
    actor: actorUri,
    object,
    to,
    cc,
  };
}

export function serializeOrderedCollection(
  uri: string,
  totalItems: number,
  firstPageUri?: string,
) {
  return {
    '@context': AP_CONTEXT,
    id: uri,
    type: 'OrderedCollection',
    totalItems,
    ...(firstPageUri && { first: firstPageUri }),
  };
}

export function serializeOrderedCollectionPage(
  uri: string,
  items: unknown[],
  partOf: string,
) {
  return {
    '@context': AP_CONTEXT,
    id: uri,
    type: 'OrderedCollectionPage',
    partOf,
    orderedItems: items,
  };
}
