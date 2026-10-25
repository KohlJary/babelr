// SPDX-License-Identifier: Hippocratic-3.0
import { useState } from 'react';
import type { ActorProfile, DMConversation } from '@babelr/shared';
import { useT } from '../i18n/I18nProvider';

interface DMConsentBarProps {
  dm: DMConversation;
  actor: ActorProfile;
  onAccept: (dmId: string) => Promise<void>;
  onDecline: (dmId: string) => Promise<void>;
  onLeave: (dmId: string) => Promise<void>;
  onBlock: (actorId: string) => Promise<void>;
}

/**
 * The DM's own controls: a pending request's Accept / Decline, who
 * left, and Leave and Block. Everyone can say no and everyone can
 * leave, so these are always here, with phone-sized tap targets.
 */
export function DMConsentBar({
  dm,
  actor,
  onAccept,
  onDecline,
  onLeave,
  onBlock,
}: DMConsentBarProps) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const other = dm.participants.find((p) => p.id !== actor.id) ?? dm.left?.[0];
  const name = other ? (other.displayName ?? other.preferredUsername) : '';

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const incoming = dm.request?.state === 'pending' && dm.request.incoming;
  const outgoing = dm.request?.state === 'pending' && !dm.request.incoming;

  return (
    <div className="dm-consent-bar">
      {incoming && (
        <div className="dm-consent-request" role="status">
          <span>{t('dm.requestIncoming', { name })}</span>
          <div className="dm-consent-actions">
            <button type="button" disabled={busy} onClick={() => void run(() => onAccept(dm.id))}>
              {t('dm.accept')}
            </button>
            <button
              type="button"
              className="dm-consent-secondary"
              disabled={busy}
              onClick={() => void run(() => onDecline(dm.id))}
            >
              {t('dm.decline')}
            </button>
          </div>
        </div>
      )}
      {outgoing && <p className="dm-consent-note">{t('dm.requestOutgoing')}</p>}
      {dm.left?.map((p) => (
        <p key={p.id} className="dm-consent-note">
          {t('dm.left', { name: p.displayName ?? p.preferredUsername })}
        </p>
      ))}
      <div className="dm-consent-actions dm-consent-menu">
        <button
          type="button"
          className="dm-consent-secondary"
          disabled={busy}
          onClick={() => {
            if (window.confirm(t('dm.confirmLeave'))) void run(() => onLeave(dm.id));
          }}
        >
          {t('dm.leave')}
        </button>
        {other && (
          <button
            type="button"
            className="dm-consent-danger"
            disabled={busy}
            onClick={() => {
              if (window.confirm(t('dm.confirmBlock', { name: other.preferredUsername }))) {
                void run(() => onBlock(other.id));
              }
            }}
          >
            {t('dm.block')}
          </button>
        )}
      </div>
      {error && (
        <p className="dm-consent-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
