// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState } from 'react';
import type {
  ArrivalConsentView,
  BlockView,
  DmPolicy,
  DmSettings,
  WelcomeSetting,
} from '@babelr/shared';
import * as api from '../api';
import { useT } from '../i18n/I18nProvider';
import type { UIStringKey } from '@babelr/shared';

const POLICY_LABELS: Array<{ value: DmPolicy; key: UIStringKey }> = [
  { value: 'anyone', key: 'dmConsent.policyAnyone' },
  { value: 'friends', key: 'dmConsent.policyFriends' },
  { value: 'members_of_shared_servers', key: 'dmConsent.policyShared' },
  { value: 'nobody', key: 'dmConsent.policyNobody' },
];

/** Settings › Messages: who can message me, who's always allowed, who's blocked. */
export function DMSettingsTab() {
  const t = useT();
  const [settings, setSettings] = useState<DmSettings | null>(null);
  const [blocks, setBlocks] = useState<BlockView[]>([]);
  const [welcome, setWelcome] = useState<WelcomeSetting[]>([]);
  const [arrivals, setArrivals] = useState<ArrivalConsentView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    Promise.all([api.getDMSettings(), api.getBlocks()])
      .then(([s, b]) => {
        setSettings(s);
        setBlocks(b);
      })
      .catch(() => setError(t('dmConsent.loadFailed')));
    // Welcoming is its own call, so an older server without it doesn't
    // break the rest of this tab.
    api
      .getWelcomeSettings()
      .then(setWelcome)
      .catch(() => setWelcome([]));
    api
      .getArrivals()
      .then(setArrivals)
      .catch(() => setArrivals([]));
  }, [t]);

  useEffect(load, [load]);

  const act = async (fn: () => Promise<void>) => {
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

  return (
    <div className="settings-tab-body dm-settings-tab">
      <h3>{t('dmConsent.title')}</h3>
      <p className="settings-hint">{t('dmConsent.hint')}</p>
      {error && (
        <p className="agents-error" role="alert">
          {error}
        </p>
      )}
      {settings && (
        <fieldset className="dm-policy-options" disabled={busy} aria-label={t('dmConsent.title')}>
          {POLICY_LABELS.map((p) => (
            <label key={p.value} className="dm-policy-option">
              <input
                type="radio"
                name="dm-policy"
                value={p.value}
                checked={settings.dmPolicy === p.value}
                onChange={() => void act(async () => setSettings(await api.setDMPolicy(p.value)))}
              />
              <span>{t(p.key)}</span>
            </label>
          ))}
        </fieldset>
      )}

      <h4>{t('dmConsent.allowlist')}</h4>
      {settings && settings.allowlist.length === 0 && (
        <p className="settings-hint">{t('dmConsent.allowlistNone')}</p>
      )}
      <ul className="agents-list">
        {settings?.allowlist.map((a) => (
          <li key={a.id} className="agents-row">
            <span className="agents-name">{a.displayName ?? a.preferredUsername}</span>
            <button
              type="button"
              className="agents-unsuspend"
              disabled={busy}
              onClick={() =>
                void act(async () => setSettings(await api.removeFromDMAllowlist(a.id)))
              }
            >
              {t('common.remove')}
            </button>
          </li>
        ))}
      </ul>

      {welcome.length > 0 && (
        <>
          <h4>{t('welcome.title')}</h4>
          <p className="settings-hint">{t('welcome.hint')}</p>
          <fieldset className="dm-policy-options" disabled={busy} aria-label={t('welcome.title')}>
            {welcome.map((w) => (
              <label key={w.serverId} className="dm-policy-option">
                <input
                  type="checkbox"
                  checked={w.welcoming}
                  onChange={(e) => {
                    const on = e.target.checked;
                    void act(async () => {
                      try {
                        const next = await api.setWelcoming(w.serverId, on);
                        setWelcome((list) =>
                          list.map((x) => (x.serverId === next.serverId ? next : x)),
                        );
                      } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        throw new Error(/key/i.test(msg) ? t('welcome.noKey') : msg);
                      }
                    });
                  }}
                />
                <span>{t('welcome.toggle', { server: w.serverName })}</span>
              </label>
            ))}
          </fieldset>
        </>
      )}

      {arrivals.length > 0 && (
        <>
          <h4>{t('arrival.settingsTitle')}</h4>
          {arrivals.map((a) => (
            <div key={a.id} className="arrival-setting">
              <p className="settings-hint" style={{ whiteSpace: 'pre-wrap' }}>
                {a.seeds}
                {a.facts.map((f) => `\n${f.key}: ${f.value}`).join('')}
              </p>
              <label className="dm-policy-option">
                <input
                  type="checkbox"
                  checked={a.lookupConsent === true}
                  disabled={busy}
                  onChange={(e) => {
                    const on = e.target.checked;
                    void act(async () => {
                      const next = await api.answerArrival(a.id, on);
                      setArrivals((list) => list.map((x) => (x.id === next.id ? next : x)));
                    });
                  }}
                />
                <span>{t('arrival.settingsYes')}</span>
              </label>
            </div>
          ))}
        </>
      )}

      <h4>{t('dmConsent.blocked')}</h4>
      {blocks.length === 0 && <p className="settings-hint">{t('dmConsent.blockedNone')}</p>}
      <ul className="agents-list">
        {blocks.map((b) => (
          <li key={b.actor.id} className="agents-row">
            <span className="agents-name">
              {b.actor.displayName ?? b.actor.preferredUsername}
              <span className="agents-meta"> @{b.actor.preferredUsername}</span>
            </span>
            <button
              type="button"
              className="agents-unsuspend"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await api.unblockActor(b.actor.id);
                  setBlocks((list) => list.filter((x) => x.actor.id !== b.actor.id));
                })
              }
            >
              {t('dmConsent.unblock')}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
