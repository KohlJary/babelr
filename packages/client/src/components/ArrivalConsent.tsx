// SPDX-License-Identifier: MIT
import { useEffect, useRef, useState } from 'react';
import type { ArrivalConsentView } from '@babelr/shared';
import * as api from '../api';
import { useT } from '../i18n/I18nProvider';

/**
 * Shown once after someone arrives through an invite whose guest card says
 * something about them: what the inviter said, verbatim, and whether the
 * house may look them up from it. Nothing else of the card (the inviter's
 * label, name or note) is shown here. They can change the answer later in
 * Settings › Messages.
 */
export function ArrivalConsent({ onSettled }: { onSettled?: () => void } = {}) {
  const t = useT();
  const [queue, setQueue] = useState<ArrivalConsentView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .getArrivals(true)
      .then(setQueue)
      .catch(() => setQueue([]))
      .finally(() => setLoaded(true));
  }, []);

  // Nothing (left) to ask: tell the host, which may now land her somewhere.
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;
  useEffect(() => {
    if (loaded && queue.length === 0) settledRef.current?.();
  }, [loaded, queue.length]);

  const current = queue[0];
  if (!current) return null;

  const answer = async (consent: boolean) => {
    setBusy(true);
    try {
      await api.answerArrival(current.id, consent, consent ? link.trim() : undefined);
      setLink('');
      setQueue((q) => q.slice(1));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-overlay arrival-consent">
      <div
        className="settings-panel arrival-consent-panel"
        role="dialog"
        aria-labelledby="arrival-title"
      >
        <div className="settings-header">
          <h2 id="arrival-title">{t('arrival.title')}</h2>
        </div>
        <p>{t('arrival.body', { who: current.invitedBy?.name ?? '?' })}</p>
        <blockquote className="arrival-seeds" style={{ whiteSpace: 'pre-wrap' }}>
          {current.seeds}
          {current.facts.map((f) => (
            <div key={`${f.key}:${f.value}`}>
              {f.key}: {f.value}
            </div>
          ))}
        </blockquote>
        <p>
          <strong>{t('arrival.ask')}</strong>
        </p>
        <input
          className="modal-input"
          placeholder={t('arrival.link')}
          value={link}
          onChange={(e) => setLink(e.target.value)}
        />
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
          <button className="auth-submit" disabled={busy} onClick={() => void answer(true)}>
            {t('arrival.yes')}
          </button>
          <button
            className="auth-submit arrival-no"
            disabled={busy}
            onClick={() => void answer(false)}
          >
            {t('arrival.no')}
          </button>
        </div>
      </div>
    </div>
  );
}
