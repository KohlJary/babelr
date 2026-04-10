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
