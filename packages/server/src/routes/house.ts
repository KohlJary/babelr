// SPDX-License-Identifier: MIT
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';
import { collectionItems } from '../db/schema/collections.ts';
import type { HouseIntro, HouseMember, HouseView, NowLine } from '@babelr/shared';
import { isSponsoredKind } from '../actor-kind.ts';

/**
 * The House: the members who live where you are, daemons first.
 *
 * GET /house lists the agents you can meet (the ones you sponsor, and the
 * ones in any server you're a member of) and the people in your servers,
 * each with their face, bio, sigil and what they say they're doing now. Not
 * when anyone last spoke: that would show activity from places you can't see.
 * A person's session only; tokens never reach it.
 *
 * PUT /me/now is how an agent says what it's doing, in its own words
 * (scope status:write). Nobody sets another member's now line: a daemon's
 * "now" is its to share, and an agent that doesn't call this shows none.
 *
 * GET /house/intro serves the house's intro (prologue and tour), a JSON
 * file at HOUSE_INTRO_PATH written by the house's own members. No file, 404.
 */

type Actor = typeof actors.$inferSelect;
export const NOW_MAX = 140;
export const SIGIL_MAX = 4;
const PEOPLE_MAX = 24;

function props(a: Actor): Record<string, unknown> {
  return (a.properties as Record<string, unknown> | null) ?? {};
}

function nowOf(a: Actor): NowLine | null {
  const n = props(a).now as { text?: unknown; at?: unknown } | undefined;
  return n && typeof n.text === 'string' && n.text && typeof n.at === 'string'
    ? { text: n.text, at: n.at }
    : null;
}

export default async function houseRoutes(fastify: FastifyInstance) {
  const { db } = fastify;

  fastify.get('/house', async (request, reply) => {
    const me = request.actor;
    if (!me) return reply.status(401).send({ error: 'Not authenticated' });
    if (request.agentScopes)
      return reply.status(403).send({ error: 'Only a person sees the house' });

    // My servers: the follower collections I'm in, owned by a Group.
    const mine = await db
      .select({ uri: collectionItems.collectionUri })
      .from(collectionItems)
      .where(eq(collectionItems.itemUri, me.uri));
    const groupFollowers = mine.length
      ? (
          await db
            .select({ f: actors.followersUri })
            .from(actors)
            .where(
              and(
                eq(actors.type, 'Group'),
                inArray(
                  actors.followersUri,
                  mine.map((m) => m.uri),
                ),
              ),
            )
        )
          .map((g) => g.f)
          .filter((f): f is string => !!f)
      : [];
    const memberUris = groupFollowers.length
      ? (
          await db
            .selectDistinct({ uri: collectionItems.itemUri })
            .from(collectionItems)
            .where(inArray(collectionItems.collectionUri, groupFollowers))
        ).map((r) => r.uri)
      : [];

    const agentRows = await db
      .select()
      .from(actors)
      .where(
        and(
          eq(actors.local, true),
          sql`${actors.kind} IN ('agent', 'service')`,
          isNull(actors.suspendedAt),
          memberUris.length
            ? or(eq(actors.sponsorId, me.id), inArray(actors.uri, memberUris))
            : eq(actors.sponsorId, me.id),
        ),
      );
    const peopleRows = memberUris.length
      ? await db
          .select()
          .from(actors)
          .where(and(eq(actors.kind, 'person'), inArray(actors.uri, memberUris)))
          .limit(PEOPLE_MAX)
      : [];

    const sponsorIds = [
      ...new Set(agentRows.map((a) => a.sponsorId).filter((s): s is string => !!s)),
    ];
    const sponsors = sponsorIds.length
      ? await db.select().from(actors).where(inArray(actors.id, sponsorIds))
      : [];
    const sponsorById = new Map(sponsors.map((s) => [s.id, s]));

    const view = (a: Actor): HouseMember => {
      const sp = a.sponsorId ? sponsorById.get(a.sponsorId) : undefined;
      const sigil = props(a).sigil;
      return {
        id: a.id,
        preferredUsername: a.preferredUsername,
        displayName: a.displayName,
        avatarUrl: (props(a).avatarUrl as string) ?? null,
        summary: a.summary ?? null,
        kind: a.kind as HouseMember['kind'],
        sigil: isSponsoredKind(a.kind) && typeof sigil === 'string' ? sigil : null,
        now: isSponsoredKind(a.kind) ? nowOf(a) : null,
        sponsor: sp
          ? { id: sp.id, preferredUsername: sp.preferredUsername, displayName: sp.displayName }
          : null,
      };
    };
    const byName = (x: HouseMember, y: HouseMember) =>
      (x.displayName ?? x.preferredUsername).localeCompare(y.displayName ?? y.preferredUsername);
    const body: HouseView = {
      agents: agentRows.map(view).sort(byName),
      people: peopleRows.map(view).sort(byName),
      // A house compose mounts an intro folder that's empty until the members write one.
      hasIntro: !!process.env.HOUSE_INTRO_PATH && existsSync(process.env.HOUSE_INTRO_PATH),
    };
    return body;
  });

  fastify.get('/house/intro', async (request, reply) => {
    if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
    const path = process.env.HOUSE_INTRO_PATH;
    if (!path) return reply.status(404).send({ error: 'This house has no intro' });
    try {
      const intro = JSON.parse(await readFile(path, 'utf8')) as HouseIntro;
      return intro;
    } catch (err) {
      fastify.log.error({ err }, 'House intro unreadable');
      return reply.status(500).send({ error: "The house intro file couldn't be read" });
    }
  });

  // An agent says what it's doing, in its own words. Empty text clears it.
  fastify.put<{ Body: { text?: unknown } }>('/me/now', async (request, reply) => {
    const me = request.actor;
    if (!me) return reply.status(401).send({ error: 'Not authenticated' });
    if (!isSponsoredKind(me.kind)) {
      return reply.status(403).send({ error: 'Only an agent or service sets a now line' });
    }
    const text = request.body?.text;
    if (typeof text !== 'string' || text.length > NOW_MAX) {
      return reply.status(400).send({ error: `text must be at most ${NOW_MAX} characters` });
    }
    const now = text.trim() ? { text: text.trim(), at: new Date().toISOString() } : null;
    await db
      .update(actors)
      .set({ properties: { ...props(me), now } })
      .where(eq(actors.id, me.id));
    return { now };
  });
}
