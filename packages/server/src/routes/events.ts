// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { eq, and, asc } from 'drizzle-orm';
import rrule from 'rrule';
const { rrulestr } = rrule;
import { writeAuditLog } from '../audit.ts';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';
import { objects } from '../db/schema/objects.ts';
import { collectionItems } from '../db/schema/collections.ts';
import { events, eventAttendees } from '../db/schema/events.ts';
import { toAuthorView } from '../serializers.ts';
import type {
  EventView,
  EventEmbedView,
  EventAttendeeView,
  EventRsvpStatus,
  CreateEventInput,
  UpdateEventInput,
} from '@babelr/shared';
import { PERMISSIONS, generateEventSlug, isValidEventSlug } from '@babelr/shared';
import { hasPermission } from '../permissions.ts';
import { enqueueToFollowers, enqueueDelivery } from '../federation/delivery.ts';
import { serializeActivity } from '../federation/jsonld.ts';
import { ensureActorKeys } from '../federation/keys.ts';

function serializeEvent(event: typeof events.$inferSelect) {
  return {
    type: 'Event',
    id: event.uri,
    name: event.title,
    content: event.description,
    slug: event.slug,
    startTime: event.startAt.toISOString(),
    endTime: event.endAt.toISOString(),
    location: event.location,
    rrule: event.rrule,
  };
}

const VALID_RSVP: EventRsvpStatus[] = ['going', 'interested', 'declined'];
const DEFAULT_LOOKAHEAD_DAYS = 60;

type Db = ReturnType<typeof import('../db/index.ts').createDb>;

async function getOwnerName(db: Db, _ownerType: string, ownerId: string): Promise<string> {
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
    slug: event.slug,
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
 * Can the actor manage (edit/delete) the event? Creator override
 * always wins; for server events, users with MANAGE_EVENTS on the
 * owning server can manage any event on that server.
 */
async function canManageEvent(
  db: Db,
  event: typeof events.$inferSelect,
  actorId: string,
): Promise<boolean> {
  if (event.createdById === actorId) return true;
  if (event.ownerType !== 'server') return false;
  return hasPermission(db, event.ownerId, actorId, PERMISSIONS.MANAGE_EVENTS);
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
      const [server] = await db.select().from(actors).where(eq(actors.id, ownerId)).limit(1);
      if (!server || server.type !== 'Group')
        return reply.status(404).send({ error: 'Server not found' });
      if (
        !(await hasPermission(db, ownerId, request.actor.id, PERMISSIONS.CREATE_EVENTS))
      ) {
        return reply.status(403).send({ error: 'Insufficient permissions' });
      }
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

    // Generate a short slug for `[[event:slug]]` embeds, retrying on
    // the (vanishingly unlikely) unique-index collision. Mirrors the
    // message slug insert pattern in channels.ts.
    let created: typeof events.$inferSelect | undefined;
    let slugAttempts = 0;
    while (!created) {
      slugAttempts++;
      try {
        const [row] = await db
          .insert(events)
          .values({
            id: eventId,
            uri: eventUri,
            slug: generateEventSlug(),
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
        created = row;
      } catch (err) {
        const pgErr = err as { code?: string };
        if (pgErr.code === '23505' && slugAttempts <= 5) continue;
        throw err;
      }
    }

    // Auto-RSVP creator as going
    await db.insert(eventAttendees).values({
      eventId: created.id,
      actorId: request.actor.id,
      status: 'going',
    });

    // Federation: deliver Create(Event) to Group followers (server events only).
    if (body.ownerType === 'server' && request.actor.local) {
      const [group] = await db.select().from(actors).where(eq(actors.id, ownerId)).limit(1);
      if (group) {
        const article = { ...serializeEvent(created), attributedTo: request.actor.uri, context: group.uri };
        const actUri = `${protocol}://${config.domain}/activities/${crypto.randomUUID()}`;
        if (!group.local && group.inboxUri) {
          const act = serializeActivity(actUri, 'Create', request.actor.uri, article, ['https://www.w3.org/ns/activitystreams#Public'], [group.followersUri ?? '']);
          ensureActorKeys(db, request.actor)
            .then((k) => enqueueDelivery(db, act, group.inboxUri!, k.id))
            .catch((err) => fastify.log.error(err, 'Event create remote federation failed'));
        } else {
          const act = serializeActivity(actUri, 'Create', group.uri, article, ['https://www.w3.org/ns/activitystreams#Public'], [group.followersUri ?? '']);
          ensureActorKeys(db, group)
            .then((k) => enqueueToFollowers(fastify, k, act))
            .catch((err) => fastify.log.error(err, 'Event create federation failed'));
        }
      }
    }

    // Audit log for server events
    if (body.ownerType === 'server') {
      await writeAuditLog(db, {
        serverId: ownerId,
        actorId: request.actor.id,
        category: 'event',
        action: 'event.create',
        summary: `Created event "${body.title.trim()}"`,
        details: { eventId: created.id },
      });
    }

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

    // For remote servers, sync events from the origin.
    if (scope === 'server' && ownerId) {
      const [serverActor] = await db.select().from(actors).where(eq(actors.id, ownerId)).limit(1);
      if (serverActor && !serverActor.local) {
        try {
          const origin = new URL(serverActor.uri).origin;
          const slug = serverActor.preferredUsername;
          const eventsUrl = `${origin}/groups/${encodeURIComponent(slug)}/events`;
          const res = await fetch(eventsUrl, {
            headers: { Accept: 'application/json', 'User-Agent': 'Babelr/0.1.0' },
            signal: AbortSignal.timeout(5_000),
          });
          if (res.ok) {
            const data = (await res.json()) as {
              events: Array<{
                uri: string; slug: string | null; title: string; description: string | null;
                startAt: string; endAt: string; location: string | null; rrule: string | null;
              }>;
            };
            for (const e of data.events ?? []) {
              if (!e.uri) continue;
              const [existing] = await db.select({ id: events.id }).from(events).where(eq(events.uri, e.uri)).limit(1);
              if (existing) {
                await db.update(events).set({
                  title: e.title, description: e.description,
                  startAt: new Date(e.startAt), endAt: new Date(e.endAt),
                  location: e.location, rrule: e.rrule, updatedAt: new Date(),
                }).where(eq(events.id, existing.id));
              } else {
                // Create event chat collection for the shadow
                const cfg = fastify.config;
                const proto = cfg.secureCookies ? 'https' : 'http';
                const chatUri = `${proto}://${cfg.domain}/events/${crypto.randomUUID()}/chat`;
                const [chatChannel] = await db.insert(objects).values({
                  uri: chatUri, type: 'OrderedCollection', belongsTo: null,
                  properties: { name: e.title, isEventChat: true },
                }).returning();
                await db.insert(events).values({
                  uri: e.uri, ownerType: 'server', ownerId: serverActor.id,
                  createdById: serverActor.id, slug: e.slug,
                  title: e.title, description: e.description,
                  startAt: new Date(e.startAt), endAt: new Date(e.endAt),
                  location: e.location, rrule: e.rrule,
                  eventChatId: chatChannel.id,
                }).onConflictDoNothing();
              }
            }
          }
        } catch {
          // Non-fatal — serve cached events.
        }
      }
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

      const manageable = await canManageEvent(db, event, request.actor.id);
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

      // Federation: deliver Update(Event).
      if (updated.ownerType === 'server' && request.actor.local) {
        const [group] = await db.select().from(actors).where(eq(actors.id, updated.ownerId)).limit(1);
        if (group) {
          const config = fastify.config;
          const protocol = config.secureCookies ? 'https' : 'http';
          const article = { ...serializeEvent(updated), attributedTo: request.actor.uri, context: group.uri };
          const actUri = `${protocol}://${config.domain}/activities/${crypto.randomUUID()}`;
          if (!group.local && group.inboxUri) {
            const act = serializeActivity(actUri, 'Update', request.actor.uri, article, ['https://www.w3.org/ns/activitystreams#Public'], [group.followersUri ?? '']);
            ensureActorKeys(db, request.actor)
              .then((k) => enqueueDelivery(db, act, group.inboxUri!, k.id))
              .catch((err) => fastify.log.error(err, 'Event update remote federation failed'));
          } else {
            const act = serializeActivity(actUri, 'Update', group.uri, article, ['https://www.w3.org/ns/activitystreams#Public'], [group.followersUri ?? '']);
            ensureActorKeys(db, group)
              .then((k) => enqueueToFollowers(fastify, k, act))
              .catch((err) => fastify.log.error(err, 'Event update federation failed'));
          }
        }
      }

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

      const manageable = await canManageEvent(db, event, request.actor.id);
      if (!manageable) return reply.status(403).send({ error: 'Insufficient permissions' });

      // Federation: deliver Delete(Event).
      if (event.ownerType === 'server' && request.actor.local) {
        const [group] = await db.select().from(actors).where(eq(actors.id, event.ownerId)).limit(1);
        if (group) {
          const config = fastify.config;
          const protocol = config.secureCookies ? 'https' : 'http';
          const actUri = `${protocol}://${config.domain}/activities/${crypto.randomUUID()}`;
          if (!group.local && group.inboxUri) {
            const act = serializeActivity(actUri, 'Delete', request.actor.uri, event.uri, ['https://www.w3.org/ns/activitystreams#Public'], [group.followersUri ?? '']);
            ensureActorKeys(db, request.actor)
              .then((k) => enqueueDelivery(db, act, group.inboxUri!, k.id))
              .catch((err) => fastify.log.error(err, 'Event delete remote federation failed'));
          } else {
            const act = serializeActivity(actUri, 'Delete', group.uri, event.uri, ['https://www.w3.org/ns/activitystreams#Public'], [group.followersUri ?? '']);
            ensureActorKeys(db, group)
              .then((k) => enqueueToFollowers(fastify, k, act))
              .catch((err) => fastify.log.error(err, 'Event delete federation failed'));
          }
        }
      }

      await db.delete(events).where(eq(events.id, event.id));
      // Cascade handles event_attendees; also clean up the event chat collection
      await db.delete(objects).where(eq(objects.id, event.eventChatId));

      // Audit log for server events
      if (event.ownerType === 'server') {
        await writeAuditLog(db, {
          serverId: event.ownerId,
          actorId: request.actor.id,
          category: 'event',
          action: 'event.delete',
          summary: `Deleted event`,
          details: { eventId: event.id },
        });
      }

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

  // Compact lookup-by-slug endpoint for `[[event:slug]]` embeds. Used
  // by the EventEmbed component to render an inline invite card
  // without paying for the full detail payload (attendee list, creator
  // actor, etc). The response includes the caller's RSVP status and
  // aggregate counts so the embed can show "12 going / 3 interested"
  // and offer an inline Join button.
  //
  // Permission: caller must be able to access the event. Returns 404
  // on both "not found" and "no access" so embeds don't leak the
  // existence of private events.
  fastify.get<{ Params: { slug: string } }>(
    '/events/by-slug/:slug',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
      const { slug } = request.params;
      if (!isValidEventSlug(slug)) {
        return reply.status(400).send({ error: 'Invalid slug format' });
      }

      const [event] = await db
        .select()
        .from(events)
        .where(eq(events.slug, slug))
        .limit(1);
      if (!event) return reply.status(404).send({ error: 'Event not found' });

      const accessible = await canAccessEvent(
        db,
        event,
        request.actor.id,
        request.actor.uri,
      );
      if (!accessible) return reply.status(404).send({ error: 'Event not found' });

      const attendees = await getAttendees(db, event.id);
      const counts = { going: 0, interested: 0, declined: 0 };
      for (const a of attendees) counts[a.status]++;
      const mine = attendees.find((a) => a.actor.id === request.actor!.id);
      const ownerName = await getOwnerName(db, event.ownerType, event.ownerId);

      const view: EventEmbedView = {
        id: event.id,
        slug: event.slug!,
        title: event.title,
        description: event.description,
        startAt: event.startAt.toISOString(),
        endAt: event.endAt.toISOString(),
        location: event.location,
        rrule: event.rrule,
        ownerType: event.ownerType as 'user' | 'server',
        ownerId: event.ownerId,
        ownerName,
        myRsvp: (mine?.status as EventRsvpStatus | undefined) ?? null,
        counts,
      };
      return view;
    },
  );

  // RSVP directly via slug, so the inline EventEmbed component can
  // offer "Join" / "Interested" / "Decline" buttons without forcing
  // the reader to open the full detail panel. Permission model is
  // identical to /events/:id/rsvp — server events require membership,
  // user events are RSVP-able by anyone who holds the slug.
  fastify.post<{ Params: { slug: string }; Body: { status: EventRsvpStatus } }>(
    '/events/by-slug/:slug/rsvp',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
      const { slug } = request.params;
      if (!isValidEventSlug(slug)) {
        return reply.status(400).send({ error: 'Invalid slug format' });
      }
      const status = request.body?.status;
      if (!VALID_RSVP.includes(status))
        return reply.status(400).send({ error: 'status must be going, interested, or declined' });

      const [event] = await db
        .select()
        .from(events)
        .where(eq(events.slug, slug))
        .limit(1);
      if (!event) return reply.status(404).send({ error: 'Event not found' });

      if (event.ownerType === 'server') {
        const accessible = await canAccessEvent(
          db,
          event,
          request.actor.id,
          request.actor.uri,
        );
        if (!accessible) return reply.status(404).send({ error: 'Event not found' });
      }

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

      const attendees = await getAttendees(db, event.id);
      const counts = { going: 0, interested: 0, declined: 0 };
      for (const a of attendees) counts[a.status]++;
      const mine = attendees.find((a) => a.actor.id === request.actor!.id);
      const ownerName = await getOwnerName(db, event.ownerType, event.ownerId);

      const view: EventEmbedView = {
        id: event.id,
        slug: event.slug!,
        title: event.title,
        description: event.description,
        startAt: event.startAt.toISOString(),
        endAt: event.endAt.toISOString(),
        location: event.location,
        rrule: event.rrule,
        ownerType: event.ownerType as 'user' | 'server',
        ownerId: event.ownerId,
        ownerName,
        myRsvp: (mine?.status as EventRsvpStatus | undefined) ?? null,
        counts,
      };
      return view;
    },
  );
}
