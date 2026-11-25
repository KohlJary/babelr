// SPDX-License-Identifier: MIT
import { useEffect, useState } from 'react';
import { useT } from '../i18n/I18nProvider';

const KEY = 'babelr:tap-hint-shown';

function isTouch(): boolean {
  try {
    return window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  } catch {
    return false;
  }
}

function alreadyShown(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return true; // no storage: don't nag on every conversation
  }
}

/**
 * Touch screens have no hover, so a message's reply / react / more only
 * show when it's tapped. Say so once, the first time any conversation
 * opens on a touch device; it's remembered from then on (localStorage).
 * It stays until she taps something (or "Got it"), or leaves that conversation.
 */
export function TapHint({ conversationId }: { conversationId: string | null }) {
  const t = useT();
  const [showFor, setShowFor] = useState<string | null>(null);

  useEffect(() => {
    if (!conversationId || showFor || !isTouch() || alreadyShown()) return;
    setShowFor(conversationId);
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      /* shown this once anyway */
    }
  }, [conversationId, showFor]);

  // Read, then out of the way: the next tap anywhere but the hint (on a
  // message, which is what it teaches, or the composer) puts it away.
  const visible = !!showFor && showFor === conversationId;
  useEffect(() => {
    if (!visible) return;
    const since = Date.now();
    const away = (e: PointerEvent) => {
      if ((e.target as Element | null)?.closest?.('.tap-hint')) return;
      if (Date.now() - since > 1500) setShowFor('dismissed');
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [visible]);

  if (!visible) return null;
  return (
    <div className="tap-hint" role="note">
      <span className="tap-hint-text">{t('messages.tapHint')}</span>
      <button type="button" className="tap-hint-ok" onClick={() => setShowFor('dismissed')}>
        {t('messages.tapHintDismiss')}
      </button>
    </div>
  );
}
