// SPDX-License-Identifier: Hippocratic-3.0
import type { AuthorView } from './messages.js';

export type EventOwnerType = 'user' | 'server';

export type EventRsvpStatus = 'going' | 'interested' | 'declined';

export interface EventAttendeeView {
  actor: AuthorView;
  status: EventRsvpStatus;
  respondedAt: string;
}

export interface EventView {
  id: string;
  uri: string;
  /**
   * Short copy-paste-friendly slug, used for `[[event:slug]]` embeds
   * in messages and wiki pages. Nullable for rows created before the
   * slug column was added; new rows always populate it.
   */
  slug: string | null;
  ownerType: EventOwnerType;
  ownerId: string;
  ownerName: string;
  createdBy: AuthorView;
  title: string;
  description: string | null;
  startAt: string;
  endAt: string;
  location: string | null;
  /** RFC 5545 recurrence rule string, if the event is recurring */
  rrule: string | null;
  /** Optional channel id the event is linked to (server events only) */
  channelId: string | null;
  /** Id of the OrderedCollection object that acts as the event's chat */
  eventChatId: string;
  /** Current caller's RSVP status, if any */
  myRsvp: EventRsvpStatus | null;
  attendees: EventAttendeeView[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Compact shape returned by the event-lookup-by-slug endpoint. Used
 * by the `<EventEmbed>` component to render inline RSVP cards for
 * `[[event:slug]]` refs. The caller can RSVP directly from the
 * embed — the full detail panel is one click away but not required
 * just to join the invite list.
 */
export interface EventEmbedView {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  startAt: string;
  endAt: string;
  location: string | null;
  rrule: string | null;
  ownerType: EventOwnerType;
  ownerId: string;
  ownerName: string;
  /** Current caller's RSVP status, if any */
  myRsvp: EventRsvpStatus | null;
  /** Count of attendees per status — avoids shipping the full list */
  counts: { going: number; interested: number; declined: number };
}

export interface CreateEventInput {
  ownerType: EventOwnerType;
  /** For server events, the server id; for user events, omit or pass your own actor id */
  ownerId?: string;
  title: string;
  description?: string;
  startAt: string;
  endAt: string;
  location?: string;
  rrule?: string;
  channelId?: string;
}

export interface UpdateEventInput {
  title?: string;
  description?: string | null;
  startAt?: string;
  endAt?: string;
  location?: string | null;
  rrule?: string | null;
  channelId?: string | null;
}

export interface EventListResponse {
  events: EventView[];
}
