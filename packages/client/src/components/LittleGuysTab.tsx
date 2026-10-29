// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState } from 'react';
import type { ServerAgentView, ServerAgentsResponse } from '@babelr/shared';
import * as api from '../api';
import { useT } from '../i18n/I18nProvider';

/**
 * "Add a little guy": a member who can invite picks an agent or service
 * and adds it to this server. The server grants it the narrowed join
 * scope and records who added it and who sponsors it.
 */
export function LittleGuysTab({ serverId }: { serverId: string }) {
  const t = useT();
  const [data, setData] = useState<ServerAgentsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .getServerAgents(serverId)
      .then(setData)
      .catch(() => setError(t('littleGuys.loadFailed')));
  }, [serverId, t]);

  useEffect(load, [load]);

  const add = async (agent: ServerAgentView) => {
    setBusy(agent.id);
    setError(null);
    try {
      await api.addServerAgent(serverId, agent.id);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const row = (a: ServerAgentView, action?: React.ReactNode) => (
    <li key={a.id} className="agents-row">
      <div className="agents-info">
        <span className="agents-name">
          {a.displayName ?? a.preferredUsername}{' '}
          <span className={`author-kind-badge author-kind-${a.kind}`}>
            {a.kind === 'service' ? t('agents.badgeService') : t('agents.badgeAgent')}
          </span>
        </span>
        <span className="agents-meta">
          @{a.preferredUsername}
          {a.sponsorUsername ? ` · ${t('littleGuys.sponsor', { name: a.sponsorUsername })}` : ''}
          {a.suspended ? ` · ${t('agents.suspended')}` : ''}
        </span>
      </div>
      {action}
    </li>
  );

  return (
    <div className="settings-tab-body agents-tab">
      <h3>{t('littleGuys.title')}</h3>
      <p className="settings-hint">{t('littleGuys.hint')}</p>
      {error && (
        <p className="agents-error" role="alert">
          {error}
        </p>
      )}
      {data && (
        <>
          <h4>{t('littleGuys.inServer')}</h4>
          {data.members.length === 0 ? (
            <p className="settings-hint">{t('littleGuys.none')}</p>
          ) : (
            <ul className="agents-list">{data.members.map((a) => row(a))}</ul>
          )}
          <h4>{t('littleGuys.available')}</h4>
          {data.candidates.length === 0 ? (
            <p className="settings-hint">{t('littleGuys.noneAvailable')}</p>
          ) : (
            <ul className="agents-list">
              {data.candidates.map((a) =>
                row(
                  a,
                  <button
                    type="button"
                    className="agents-unsuspend"
                    disabled={busy === a.id}
                    onClick={() => void add(a)}
                  >
                    {t('littleGuys.add')}
                  </button>,
                ),
              )}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
