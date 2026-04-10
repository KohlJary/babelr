// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { eq, and, asc } from 'drizzle-orm';
import { rrulestr } from 'rrule';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';
import { objects } from '../db/schema/objects.ts';
import { collectionItems } from '../db/schema/collections.ts';
import { events, eventAttendees } from '../db/schema/events.ts';
import { toAuthorView } from './channels.ts';
import type {
  EventView,
  EventAttendeeView,
  EventRsvpStatus,
  CreateEventInput,
  UpdateEventInput,
} from '@babelr/shared';

const VALID_RSVP: EventRsvpStatus[] = ['going', 'interested', 'declined'];
const DEFAULT_LOOKAHEAD_DAYS = 60;

type Db = ReturnType<typeof import('../db/index.ts').createDb>;

async function getOwnerName(db: Db, ownerType: string, ownerId: string): Promise<string> {
  const [a] = await db.select().from(actors).where(eq(actors.id, ownerId)).limit(1);
  if (!a) return 'Unknown';
  return a.displayName ?? a.preferredUsername;
}

async function getAttendees(db: Db, eventId: string): Promise<EventAttendeeView[]> {
  const rows = await db
    .select({ att: eventAttendees, actor: actors })
    .from(eventAttendees)
    .innerJoin(actors, eq(eventAttendees.actorId, actors.id))
    .where(eq(eventAttendees.eventId, eventId))
    .orderBy(asc(eventAttendees.respondedAt));
  return rows.map((r) => ({
    actor: toAuthorView(r.actor),
    status: r.att.status as EventRsvpStatus,
    respondedAt: r.att.respondedAt.toISOString(),
  }));
}

async function toEventView(
  db: Db,
  event: typeof events.$inferSelect,
  callerId: string,
): Promise<EventView> {
  const [creator] = await db.select().from(actors).where(eq(actors.id, event.createdById)).limit(1);
  const ownerName = await getOwnerName(db, event.ownerType, event.ownerId);
  const attendees = await getAttendees(db, event.id);
  const mine = attendees.find((a) => a.actor.id === callerId);
  return {
    id: event.id,
    uri: event.uri,
    ownerType: event.ownerType as 'user' | 'server',
    ownerId: event.ownerId,
    ownerName,
    createdBy: creator ? toAuthorView(creator) : { id: event.createdById, preferredUsername: 'unknown', displayName: null, avatarUrl: null },
    title: event.title,
    description: event.description,
    startAt: event.startAt.toISOString(),
    endAt: event.endAt.toISOString(),
    location: event.location,
    rrule: event.rrule,
    channelId: event.channelId,
    eventChatId: event.eventChatId,
    myRsvp: (mine?.status as EventRsvpStatus | undefined) ?? null,
    attendees,
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.updatedAt.toISOString(),
  };
}

/**
 * Check whether an actor can see an event. Server events are visible to
 * anyone in the server's followers collection; user events are visible to
 * the owner and to any attendees (RSVP rows grant visibility).
 */
async function canAccessEvent(
  db: Db,
  event: typeof events.$inferSelect,
  actorId: string,
  actorUri: string,
): Promise<boolean> {
  if (event.ownerType === 'user') {
    if (event.ownerId === actorId) return true;
    // Attendees can see
    const [rsvp] = await db
      .select({ id: eventAttendees.id })
      .from(eventAttendees)
      .where(and(eq(eventAttendees.eventId, event.id), eq(eventAttendees.actorId, actorId)))
      .limit(1);
    return !!rsvp;
  }
  // Server event — check server membership
  const [server] = await db.select().from(actors).where(eq(actors.id, event.ownerId)).limit(1);
  if (!server?.followersUri) return false;
  const [member] = await db
    .select({ id: collectionItems.id })
    .from(collectionItems)
    .where(
      and(
        eq(collectionItems.collectionUri, server.followersUri),
        eq(collectionItems.itemUri, actorUri),
      ),
    )
    .limit(1);
  return !!member;
}

/**
 * Can the actor manage (edit/delete) the event? Creator always can;
 * for server events, owners/admins/moderators can as well.
 */
async function canManageEvent(
  db: Db,
  event: typeof events.$inferSelect,
  actorId: string,
  actorUri: string,
): Promise<boolean> {
  if (event.createdById === actorId) return true;
  if (event.ownerType !== 'server') return false;
  const [server] = await db.select().from(actors).where(eq(actors.id, event.ownerId)).limit(1);
  if (!server?.followersUri) return false;
  const [member] = await db
    .select()
    .from(collectionItems)
    .where(
      and(
        eq(collectionItems.collectionUri, server.followersUri),
        eq(collectionItems.itemUri, actorUri),
      ),
    )
    .limit(1);
  const props = member?.properties as Record<string, unknown> | null;
  const role = (props?.role as string) ?? 'member';
  const serverProps = server.properties as Record<string, unknown> | null;
  return serverProps?.ownerId === actorId || ['owner', 'admin', 'moderator'].includes(role);
}

/**
 * Expand a recurring event into concrete instances within a time window.
 * Returns the same event shape with startAt/endAt adjusted per occurrence.
 * Non-recurring events are returned as-is if they fall in the window.
 */
function expandRecurrence(
  event: EventView,
  rangeStart: Date,
  rangeEnd: Date,
): EventView[] {
  if (!event.rrule) {
    const start = new Date(event.startAt);
    const end = new Date(event.endAt);
    if (end < rangeStart || start > rangeEnd) return [];
    return [event];
  }

  try {
    const dtstart = new Date(event.startAt);
    const duration = new Date(event.endAt).getTime() - dtstart.getTime();
    // Prepend DTSTART so rrulestr can parse
    const ruleWithDtstart = `DTSTART:${dtstart
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '')}\nRRULE:${event.rrule}`;
    const rule = rrulestr(ruleWithDtstart);
    const occurrences = rule.between(rangeStart, rangeEnd, true);
    return occurrences.map((occ) => ({
      ...event,
      // Give each instance a deterministic key for React rendering
      id: `${event.id}:${occ.toISOString()}`,
      startAt: occ.toISOString(),
      endAt: new Date(occ.getTime() + duration).toISOString(),
    }));
  } catch {
    // Malformed rule — fall back to showing the base event once
    return [event];
  }
}

export default async function eventRoutes(fastify: FastifyInstance) {
  const db = fastify.db;
  const config = fastify.config;
  const protocol = config.secureCookies ? 'https' : 'http';

  // Create an event
  fastify.post<{ Body: CreateEventInput }>('/events', async (request, reply) => {
    if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });

    const body = request.body;
    if (!body?.title?.trim()) return reply.status(400).send({ error: 'title is required' });
    if (!body.startAt || !body.endAt)
      return reply.status(400).send({ error: 'startAt and endAt are required' });
    if (body.ownerType !== 'user' && body.ownerType !== 'server')
      return reply.status(400).send({ error: 'ownerType must be user or server' });

    const startAt = new Date(body.startAt);
    const endAt = new Date(body.endAt);
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime()))
      return reply.status(400).send({ error: 'startAt/endAt must be valid ISO timestamps' });
    if (endAt <= startAt)
      return reply.status(400).send({ error: 'endAt must be after startAt' });

    let ownerId: string;
    if (body.ownerType === 'user') {
      ownerId = body.ownerId ?? request.actor.id;
      if (ownerId !== request.actor.id)
        return reply.status(403).send({ error: 'Can only create user events for yourself' });
    } else {
      if (!body.ownerId) return reply.status(400).send({ error: 'ownerId is required for server events' });
      ownerId = body.ownerId;
      // Verify caller has mod+ role on the server
      const [server] = await db.select().from(actors).where(eq(actors.id, ownerId)).limit(1);
      if (!server || server.type !== 'Group')
        return reply.status(404).send({ error: 'Server not found' });
      if (!server.followersUri)
        return reply.status(400).send({ error: 'Server has no followers collection' });
      const [member] = await db
        .select()
        .from(collectionItems)
        .where(
          and(
            eq(collectionItems.collectionUri, server.followersUri),
            eq(collectionItems.itemUri, request.actor.uri),
          ),
        )
        .limit(1);
      const props = member?.properties as Record<string, unknown> | null;
      const role = (props?.role as string) ?? 'member';
      const serverProps = server.properties as Record<string, unknown> | null;
      const isMod =
        serverProps?.ownerId === request.actor.id ||
        ['owner', 'admin', 'moderator'].includes(role);
      if (!isMod) return reply.status(403).send({ error: 'Insufficient permissions' });
    }

    // Validate channelId if provided (server events only)
    if (body.channelId) {
      if (body.ownerType !== 'server')
        return reply.status(400).send({ error: 'channelId is only valid for server events' });
      const [ch] = await db
        .select()
        .from(objects)
        .where(and(eq(objects.id, body.channelId), eq(objects.type, 'OrderedCollection')))
        .limit(1);
      if (!ch || ch.belongsTo !== ownerId)
        return reply.status(400).send({ error: 'channelId does not belong to this server' });
    }

    // Create event chat collection
    const eventId = crypto.randomUUID();
    const eventUri = `${protocol}://${config.domain}/events/${eventId}`;
    const chatUri = `${protocol}://${config.domain}/events/${eventId}/chat`;

    const [chatChannel] = await db
      .insert(objects)
      .values({
        uri: chatUri,
        type: 'OrderedCollection',
        belongsTo: null,
        properties: { name: body.title, isEventChat: true, eventId },
      })
      .returning();

    const [created] = await db
      .insert(events)
      .values({
        id: eventId,
        uri: eventUri,
        ownerType: body.ownerType,
        ownerId,
        createdById: request.actor.id,
        title: body.title.trim(),
        description: body.description?.trim() || null,
        startAt,
        endAt,
        location: body.location?.trim() || null,
        rrule: body.rrule?.trim() || null,
        channelId: body.channelId ?? null,
        eventChatId: chatChannel.id,
      })
      .returning();

    // Auto-RSVP creator as going
    await db.insert(eventAttendees).values({
      eventId: created.id,
      actorId: request.actor.id,
      status: 'going',
    });

    const view = await toEventView(db, created, request.actor.id);
    return reply.status(201).send(view);
  });

  // List events — filterable by owner scope and time range
  fastify.get<{
    Querystring: { scope?: 'user' | 'server'; ownerId?: string; rangeStart?: string; rangeEnd?: string };
  }>('/events', async (request, reply) => {
    if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });

    const { scope, ownerId } = request.query;
    const rangeStart = request.query.rangeStart ? new Date(request.query.rangeStart) : new Date();
    const rangeEnd = request.query.rangeEnd
      ? new Date(request.query.rangeEnd)
      : new Date(Date.now() + DEFAULT_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);

    const conditions = [];
    if (scope === 'user') {
      conditions.push(eq(events.ownerType, 'user'));
      conditions.push(eq(events.ownerId, ownerId ?? request.actor.id));
    } else if (scope === 'server') {
      if (!ownerId) return reply.status(400).send({ error: 'ownerId required when scope=server' });
      conditions.push(eq(events.ownerType, 'server'));
      conditions.push(eq(events.ownerId, ownerId));
    }

    // Fetch all events matching the scope filters; we do range filtering
    // and recurrence expansion in memory since the per-scope set is small
    // and the filtering logic is non-trivial (recurring events need
    // expansion before we know which instances fall in the window).
    const rows = await db
      .select()
      .from(events)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(events.startAt));

    // Filter by visibility and expand recurrences
    const out: EventView[] = [];
    for (const row of rows) {
      const accessible = await canAccessEvent(db, row, request.actor.id, request.actor.uri);
      if (!accessible) continue;
      const base = await toEventView(db, row, request.actor.id);
      if (row.rrule) {
        out.push(...expandRecurrence(base, rangeStart, rangeEnd));
      } else {
        const start = new Date(base.startAt);
        if (start >= rangeStart && start <= rangeEnd) out.push(base);
      }
    }
    // Sort by startAt ascending
    out.sort((a, b) => a.startAt.localeCompare(b.startAt));
    return { events: out };
  });

  // Get one event
  fastify.get<{ Params: { eventId: string } }>('/events/:eventId', async (request, reply) => {
    if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });

    const [event] = await db
      .select()
      .from(events)
      .where(eq(events.id, request.params.eventId))
      .limit(1);
    if (!event) return reply.status(404).send({ error: 'Event not found' });

    const accessible = await canAccessEvent(db, event, request.actor.id, request.actor.uri);
    if (!accessible) return reply.status(403).send({ error: 'Forbidden' });

    return toEventView(db, event, request.actor.id);
  });

  // Update an event
  fastify.put<{ Params: { eventId: string }; Body: UpdateEventInput }>(
    '/events/:eventId',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });

      const [event] = await db
        .select()
        .from(events)
        .where(eq(events.id, request.params.eventId))
        .limit(1);
      if (!event) return reply.status(404).send({ error: 'Event not found' });

      const manageable = await canManageEvent(db, event, request.actor.id, request.actor.uri);
      if (!manageable) return reply.status(403).send({ error: 'Insufficient permissions' });

      const body = request.body ?? {};
      const updates: Record<string, unknown> = { updatedAt: new Date() };

      if (body.title !== undefined) {
        if (!body.title.trim()) return reply.status(400).send({ error: 'title cannot be empty' });
        updates.title = body.title.trim();
      }
      if (body.description !== undefined) updates.description = body.description?.trim() || null;
      if (body.location !== undefined) updates.location = body.location?.trim() || null;
      if (body.rrule !== undefined) updates.rrule = body.rrule?.trim() || null;
      if (body.startAt !== undefined) {
        const d = new Date(body.startAt);
        if (Number.isNaN(d.getTime())) return reply.status(400).send({ error: 'invalid startAt' });
        updates.startAt = d;
      }
      if (body.endAt !== undefined) {
        const d = new Date(body.endAt);
        if (Number.isNaN(d.getTime())) return reply.status(400).send({ error: 'invalid endAt' });
        updates.endAt = d;
      }
      if (body.channelId !== undefined) {
        if (body.channelId !== null && event.ownerType !== 'server')
          return reply.status(400).send({ error: 'channelId only valid for server events' });
        if (body.channelId) {
          const [ch] = await db
            .select()
            .from(objects)
            .where(and(eq(objects.id, body.channelId), eq(objects.type, 'OrderedCollection')))
            .limit(1);
          if (!ch || ch.belongsTo !== event.ownerId)
            return reply.status(400).send({ error: 'channelId does not belong to this server' });
        }
        updates.channelId = body.channelId;
      }

      const [updated] = await db
        .update(events)
        .set(updates)
        .where(eq(events.id, event.id))
        .returning();

      return toEventView(db, updated, request.actor.id);
    },
  );

  // Delete an event
  fastify.delete<{ Params: { eventId: string } }>(
    '/events/:eventId',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });

      const [event] = await db
        .select()
        .from(events)
        .where(eq(events.id, request.params.eventId))
        .limit(1);
      if (!event) return reply.status(404).send({ error: 'Event not found' });

      const manageable = await canManageEvent(db, event, request.actor.id, request.actor.uri);
      if (!manageable) return reply.status(403).send({ error: 'Insufficient permissions' });

      await db.delete(events).where(eq(events.id, event.id));
      // Cascade handles event_attendees; also clean up the event chat collection
      await db.delete(objects).where(eq(objects.id, event.eventChatId));
      return { ok: true };
    },
  );

  // Set RSVP
  fastify.post<{ Params: { eventId: string }; Body: { status: EventRsvpStatus } }>(
    '/events/:eventId/rsvp',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });

      const status = request.body?.status;
      if (!VALID_RSVP.includes(status))
        return reply.status(400).send({ error: 'status must be going, interested, or declined' });

      const [event] = await db
        .select()
        .from(events)
        .where(eq(events.id, request.params.eventId))
        .limit(1);
      if (!event) return reply.status(404).send({ error: 'Event not found' });

      // For server events, you must be a server member; for user events, anyone
      // with the event id can RSVP (there's no notion of private user events
      // yet beyond not being discoverable)
      if (event.ownerType === 'server') {
        const accessible = await canAccessEvent(db, event, request.actor.id, request.actor.uri);
        if (!accessible) return reply.status(403).send({ error: 'Not a member of this server' });
      }

      // Upsert
      const [existing] = await db
        .select()
        .from(eventAttendees)
        .where(
          and(
            eq(eventAttendees.eventId, event.id),
            eq(eventAttendees.actorId, request.actor.id),
          ),
        )
        .limit(1);

      if (existing) {
        await db
          .update(eventAttendees)
          .set({ status, respondedAt: new Date() })
          .where(eq(eventAttendees.id, existing.id));
      } else {
        await db.insert(eventAttendees).values({
          eventId: event.id,
          actorId: request.actor.id,
          status,
        });
      }

      return toEventView(db, event, request.actor.id);
    },
  );
}
