// SPDX-License-Identifier: Hippocratic-3.0

export type ActorType = 'Person' | 'Group' | 'Service' | 'Application';

export type ObjectType =
  | 'Note'
  | 'Article'
  | 'OrderedCollection'
  | 'Image'
  | 'Tombstone';

export type ActivityType =
  | 'Create'
  | 'Update'
  | 'Delete'
  | 'Follow'
  | 'Like'
  | 'Announce'
  | 'Accept'
  | 'Reject'
  | 'Undo'
  | 'Add'
  | 'Remove';

export interface Actor {
  id: string;
  uri: string;
  type: ActorType;
  preferredUsername: string;
  displayName?: string | null;
  summary?: string | null;
  inboxUri: string;
  outboxUri: string;
  followersUri?: string | null;
  followingUri?: string | null;
  preferredLanguage: string;
  local: boolean;
  properties: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface APObject {
  id: string;
  uri: string;
  type: ObjectType;
  attributedTo?: string | null;
  content?: string | null;
  contentMap?: Record<string, string> | null;
  mediaType: string;
  source?: { content: string; mediaType: string } | null;
  inReplyTo?: string | null;
  context?: string | null;
  to: string[];
  cc: string[];
  belongsTo?: string | null;
  properties: Record<string, unknown>;
  published: Date;
  updated?: Date | null;
}

export interface Activity {
  id: string;
  uri: string;
  type: ActivityType;
  actorId: string;
  objectUri: string;
  objectId?: string | null;
  targetUri?: string | null;
  to: string[];
  cc: string[];
  properties: Record<string, unknown>;
  published: Date;
}

export interface CollectionItem {
  id: string;
  collectionUri: string;
  collectionId?: string | null;
  itemUri: string;
  itemId?: string | null;
  position?: number | null;
  addedAt: Date;
}
