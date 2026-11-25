// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState } from 'react';
import type { GuestCardView, UIStringKey } from '@babelr/shared';
import * as api from '../api';
import { useT } from '../i18n/I18nProvider';

/**
 * Server Settings › People you're inviting: guest cards, plain list and
 * form. Set the person up first, then "Make invite" mints a single-use
 * link tied to the card.
 */
export function GuestCardsTab({ serverId }: { serverId: string }) {
  const t = useT();
  const [cards, setCards] = useState<GuestCardView[]>([]);
  const [form, setForm] = useState({ name: '', label: '', seeds: '', note: '' });
  const [links, setLinks] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .listGuestCards(serverId)
      .then(setCards)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [serverId]);
  useEffect(load, [load]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const status = (c: GuestCardView) =>
    t(`guests.status.${c.status}` as UIStringKey, { handle: c.joined?.preferredUsername ?? '' });

  return (
    <div className="settings-tab-content guest-cards">
      <p className="settings-hint">{t('guests.hint')}</p>
      {error && (
        <p className="agents-error" role="alert">
          {error}
        </p>
      )}
      {cards.length === 0 && <div className="sidebar-empty">{t('guests.none')}</div>}
      <ul className="agents-list">
        {cards.map((c) => {
          const url = links[c.id] ?? c.invite?.url;
          return (
            <li key={c.id} className="agents-row guest-card-row" style={{ flexWrap: 'wrap' }}>
              <span className="agents-name">
                {c.name}
                {c.label && <span className="agents-meta"> ({c.label})</span>}
                <span className="agents-meta"> · {status(c)}</span>
                {c.seeds && <div className="agents-meta">{c.seeds}</div>}
                {url && c.status === 'link_made' && (
                  <div className="agents-meta" style={{ wordBreak: 'break-all' }}>
                    {url}
                  </div>
                )}
              </span>
              {c.mine && c.status !== 'joined' && c.status !== 'declined_lookup' && (
                <button
                  type="button"
                  className="agents-unsuspend"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const inv = await api.makeGuestInvite(c.id);
                      setLinks((l) => ({ ...l, [c.id]: inv.url }));
                      try {
                        await navigator.clipboard.writeText(inv.url);
                      } catch {
                        // Clipboard can be refused; the link is shown either way.
                      }
                      load();
                    })
                  }
                >
                  {c.status === 'link_made' ? t('guests.remakeInvite') : t('guests.makeInvite')}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      <div className="settings-divider" />
      <form
        className="settings-field"
        style={{ gap: '0.5rem' }}
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            await api.createGuestCard(serverId, {
              name: form.name,
              label: form.label || null,
              seeds: form.seeds || null,
              note: form.note || null,
            });
            setForm({ name: '', label: '', seeds: '', note: '' });
            load();
          });
        }}
      >
        <input
          className="modal-input"
          placeholder={t('guests.name')}
          value={form.name}
          required
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <input
          className="modal-input"
          placeholder={t('guests.label')}
          value={form.label}
          onChange={(e) => setForm({ ...form, label: e.target.value })}
        />
        <textarea
          className="modal-input"
          placeholder={t('guests.seeds')}
          value={form.seeds}
          rows={2}
          onChange={(e) => setForm({ ...form, seeds: e.target.value })}
        />
        <textarea
          className="modal-input"
          placeholder={t('guests.note')}
          value={form.note}
          rows={3}
          onChange={(e) => setForm({ ...form, note: e.target.value })}
        />
        <button className="auth-submit" type="submit" disabled={busy || !form.name.trim()}>
          {t('guests.add')}
        </button>
      </form>
    </div>
  );
}
