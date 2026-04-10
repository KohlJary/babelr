// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect, useCallback } from 'react';
import type {
  EventView,
  CreateEventInput,
  UpdateEventInput,
  EventRsvpStatus,
} from '@babelr/shared';
import * as api from '../api';

interface UseEventsOptions {
  scope: 'user' | 'server';
  ownerId?: string;
  rangeStart?: string;
  rangeEnd?: string;
}

/**
 * Loads and mutates events for a given scope (user calendar or server calendar).
 * Expanded recurring instances share the same `id` prefix as their parent
 * (instance ids look like `parent-uuid:2026-05-12T15:00:00.000Z`) so the
 * mutators operate on the base id derived via splitBaseId.
 */
function splitBaseId(id: string): string {
  const colonIdx = id.indexOf(':');
  return colonIdx === -1 ? id : id.slice(0, colonIdx);
}

export function useEvents({ scope, ownerId, rangeStart, rangeEnd }: UseEventsOptions) {
  const [events, setEvents] = useState<EventView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listEvents({ scope, ownerId, rangeStart, rangeEnd });
      setEvents(res.events);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load events');
    } finally {
      setLoading(false);
    }
  }, [scope, ownerId, rangeStart, rangeEnd]);

  useEffect(() => {
    reload();
  }, [reload]);

  const createEvent = useCallback(
    async (input: CreateEventInput) => {
      const row = await api.createEvent(input);
      setEvents((prev) => [row, ...prev].sort((a, b) => a.startAt.localeCompare(b.startAt)));
      return row;
    },
    [],
  );

  const updateEvent = useCallback(
    async (eventId: string, input: UpdateEventInput) => {
      const baseId = splitBaseId(eventId);
      const row = await api.updateEvent(baseId, input);
      // Reload because recurrence expansion changes shape
      await reload();
      return row;
    },
    [reload],
  );

  const deleteEvent = useCallback(
    async (eventId: string) => {
      const baseId = splitBaseId(eventId);
      await api.deleteEvent(baseId);
      setEvents((prev) => prev.filter((e) => splitBaseId(e.id) !== baseId));
    },
    [],
  );

  const rsvpEvent = useCallback(
    async (eventId: string, status: EventRsvpStatus) => {
      const baseId = splitBaseId(eventId);
      const row = await api.rsvpEvent(baseId, status);
      setEvents((prev) =>
        prev.map((e) =>
          splitBaseId(e.id) === baseId
            ? { ...row, id: e.id, startAt: e.startAt, endAt: e.endAt }
            : e,
        ),
      );
      return row;
    },
    [],
  );

  return { events, loading, error, reload, createEvent, updateEvent, deleteEvent, rsvpEvent };
}
