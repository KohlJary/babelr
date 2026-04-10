// SPDX-License-Identifier: Hippocratic-3.0
import { useState } from 'react';
import type React from 'react';
import type { CreateEventInput, ChannelView } from '@babelr/shared';
import { useT } from '../i18n/I18nProvider';

interface CreateEventModalProps {
  scope: 'user' | 'server';
  ownerId: string;
  channels?: ChannelView[]; // optional — only relevant for server scope
  onCreate: (input: CreateEventInput) => Promise<void>;
  onClose: () => void;
}

type RecurrenceOption = 'none' | 'daily' | 'weekly' | 'biweekly' | 'monthly';

function recurrenceToRrule(opt: RecurrenceOption): string | undefined {
  switch (opt) {
    case 'daily':
      return 'FREQ=DAILY';
    case 'weekly':
      return 'FREQ=WEEKLY';
    case 'biweekly':
      return 'FREQ=WEEKLY;INTERVAL=2';
    case 'monthly':
      return 'FREQ=MONTHLY';
    default:
      return undefined;
  }
}

/** Format a Date as the value expected by <input type="datetime-local">. */
function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export function CreateEventModal({
  scope,
  ownerId,
  channels,
  onCreate,
  onClose,
}: CreateEventModalProps) {
  const t = useT();

  // Default: today at next hour boundary, 1h duration
  const defaultStart = new Date();
  defaultStart.setMinutes(0, 0, 0);
  defaultStart.setHours(defaultStart.getHours() + 1);
  const defaultEnd = new Date(defaultStart);
  defaultEnd.setHours(defaultEnd.getHours() + 1);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [startAt, setStartAt] = useState(toLocalInput(defaultStart));
  const [endAt, setEndAt] = useState(toLocalInput(defaultEnd));
  const [location, setLocation] = useState('');
  const [recurrence, setRecurrence] = useState<RecurrenceOption>('none');
  const [channelId, setChannelId] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const input: CreateEventInput = {
        ownerType: scope,
        ownerId,
        title: title.trim(),
        description: description.trim() || undefined,
        startAt: new Date(startAt).toISOString(),
        endAt: new Date(endAt).toISOString(),
        location: location.trim() || undefined,
        rrule: recurrenceToRrule(recurrence),
        channelId: scope === 'server' && channelId ? channelId : undefined,
      };
      await onCreate(input);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('events.failedToCreate'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel settings-panel-wide" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>{t('events.createEvent')}</h2>
          <button className="settings-close" onClick={onClose}>
            &times;
          </button>
        </div>

        <form onSubmit={handleSubmit} className="settings-tab-content">
          <div className="settings-field">
            <label htmlFor="event-title">{t('events.eventTitle')}</label>
            <input
              id="event-title"
              type="text"
              className="modal-input"
              placeholder={t('events.eventTitlePlaceholder')}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={256}
              autoFocus
            />
          </div>

          <div className="settings-field">
            <label htmlFor="event-description">{t('events.eventDescription')}</label>
            <textarea
              id="event-description"
              className="modal-input"
              placeholder={t('events.eventDescriptionPlaceholder')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
            />
          </div>

          <div style={{ display: 'flex', gap: '1rem' }}>
            <div className="settings-field" style={{ flex: 1 }}>
              <label htmlFor="event-start">{t('events.startAt')}</label>
              <input
                id="event-start"
                type="datetime-local"
                className="modal-input"
                value={startAt}
                onChange={(e) => setStartAt(e.target.value)}
                required
              />
            </div>
            <div className="settings-field" style={{ flex: 1 }}>
              <label htmlFor="event-end">{t('events.endAt')}</label>
              <input
                id="event-end"
                type="datetime-local"
                className="modal-input"
                value={endAt}
                onChange={(e) => setEndAt(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="settings-field">
            <label htmlFor="event-location">{t('events.location')}</label>
            <input
              id="event-location"
              type="text"
              className="modal-input"
              placeholder={t('events.locationPlaceholder')}
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              maxLength={256}
            />
          </div>

          <div className="settings-field">
            <label htmlFor="event-recurrence">{t('events.recurrence')}</label>
            <select
              id="event-recurrence"
              className="modal-input"
              value={recurrence}
              onChange={(e) => setRecurrence(e.target.value as RecurrenceOption)}
            >
              <option value="none">{t('events.noRecurrence')}</option>
              <option value="daily">{t('events.recurDaily')}</option>
              <option value="weekly">{t('events.recurWeekly')}</option>
              <option value="biweekly">{t('events.recurBiweekly')}</option>
              <option value="monthly">{t('events.recurMonthly')}</option>
            </select>
          </div>

          {scope === 'server' && channels && channels.length > 0 && (
            <div className="settings-field">
              <label htmlFor="event-channel">{t('events.linkedChannel')}</label>
              <select
                id="event-channel"
                className="modal-input"
                value={channelId}
                onChange={(e) => setChannelId(e.target.value)}
              >
                <option value="">{t('events.noLinkedChannel')}</option>
                {channels.map((ch) => (
                  <option key={ch.id} value={ch.id}>
                    #{ch.name}
                  </option>
                ))}
              </select>
              <p className="settings-hint">{t('events.linkedChannelHint')}</p>
            </div>
          )}

          {error && <div className="dm-lookup-error">{error}</div>}

          <div className="settings-divider" />

          <button type="submit" className="auth-submit" disabled={submitting || !title.trim()}>
            {submitting ? t('common.saving') : t('events.createEvent')}
          </button>
        </form>
      </div>
    </div>
  );
}
