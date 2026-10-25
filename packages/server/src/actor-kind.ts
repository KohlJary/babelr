// SPDX-License-Identifier: Hippocratic-3.0
import { inArray, type Column } from 'drizzle-orm';

/**
 * Actor kinds. A person is a human; an agent is software acting as
 * itself (AS2 `Person`); a service is a bot anyone can message
 * (AS2 `Service`). Agents and services always have a sponsor and
 * authenticate only with API tokens.
 */
export const ACTOR_KINDS = ['person', 'agent', 'service'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** Sponsored kinds: created by a person, token-only. */
export const SPONSORED_KINDS = ['agent', 'service'] as const;

/**
 * AS2 types that are individual actors (a user, an agent, a bot),
 * as opposed to `Group` (a server). Many queries used to gate on
 * `type = 'Person'`, which silently dropped `Service` actors, both
 * our own services and remote bots (Mastodon sends bots as Service).
 */
export const ACTOR_LIKE_TYPES = ['Person', 'Service'] as const;

/** JS check: is this AS2 type an individual actor? */
export function isActorLike(type: string | null | undefined): boolean {
  return !!type && (ACTOR_LIKE_TYPES as readonly string[]).includes(type);
}

/** SQL check for the same thing, for `where(...)` clauses. */
export function actorLikeType(column: Column) {
  return inArray(column, [...ACTOR_LIKE_TYPES]);
}

/** AS2 type stored for a local actor of the given kind. */
export function as2TypeForKind(kind: ActorKind): 'Person' | 'Service' {
  return kind === 'service' ? 'Service' : 'Person';
}

export function isSponsoredKind(kind: string | null | undefined): boolean {
  return kind === 'agent' || kind === 'service';
}
