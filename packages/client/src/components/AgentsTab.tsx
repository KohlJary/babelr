// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState } from 'react';
import type { ActorProfile, AgentView } from '@babelr/shared';
import * as api from '../api';
import { useT } from '../i18n/I18nProvider';
import { ProfilePanel } from './ProfilePanel';

/** The profile panel's shape for an agent (it has no email or 2FA). */
function asProfile(a: AgentView): ActorProfile {
  return {
    id: a.id,
    uri: '',
    preferredUsername: a.preferredUsername,
    displayName: a.displayName,
    summary: a.summary,
    avatarUrl: a.avatarUrl,
    preferredLanguage: 'en',
    emailVerified: false,
    totpEnabled: false,
    createdAt: new Date(a.createdAt),
  };
}

/**
 * The kill switch: every agent and service this person sponsors, each
 * with one Suspend button. Big tap targets so it works from a phone.
 * Suspending revokes all the agent's tokens on the server at once.
 */
export function AgentsTab() {
  const t = useT();
  const [agents, setAgents] = useState<AgentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<AgentView | null>(null);

  const load = useCallback(() => {
    api
      .getMyAgents()
      .then(setAgents)
      .catch(() => setError(t('agents.loadFailed')));
  }, [t]);

  useEffect(load, [load]);

  const toggle = async (agent: AgentView) => {
    if (
      !agent.suspendedAt &&
      !window.confirm(t('agents.confirmSuspend', { name: agent.preferredUsername }))
    ) {
      return;
    }
    setBusy(agent.id);
    setError(null);
    try {
      const updated = agent.suspendedAt
        ? await api.unsuspendAgent(agent.id)
        : (await api.suspendAgent(agent.id)).agent;
      setAgents((list) => list?.map((a) => (a.id === updated.id ? updated : a)) ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="settings-tab-body agents-tab">
      <h3>{t('agents.title')}</h3>
      <p className="settings-hint">{t('agents.hint')}</p>
      {error && (
        <p className="agents-error" role="alert">
          {error}
        </p>
      )}
      {agents && agents.length === 0 && <p className="settings-hint">{t('agents.none')}</p>}
      <ul className="agents-list">
        {agents?.map((a) => (
          <li key={a.id} className={`agents-row${a.suspendedAt ? ' agents-row-suspended' : ''}`}>
            <div className="agents-info">
              <span className="agents-name">
                {a.displayName ?? a.preferredUsername}{' '}
                <span className={`author-kind-badge author-kind-${a.kind}`}>
                  {a.kind === 'service' ? t('agents.badgeService') : t('agents.badgeAgent')}
                </span>
              </span>
              <span className="agents-meta">
                @{a.preferredUsername} ·{' '}
                {a.suspendedAt
                  ? t('agents.suspended')
                  : t('agents.activeTokens', { count: a.activeTokens })}
              </span>
            </div>
            <button type="button" className="agents-edit" onClick={() => setEditing(a)}>
              {t('agents.editProfile')}
            </button>
            <button
              type="button"
              className={a.suspendedAt ? 'agents-unsuspend' : 'agents-suspend'}
              disabled={busy === a.id}
              onClick={() => void toggle(a)}
            >
              {a.suspendedAt ? t('agents.unsuspend') : t('agents.suspend')}
            </button>
          </li>
        ))}
      </ul>
      {editing && (
        <ProfilePanel
          actor={asProfile(editing)}
          title={t('agents.profileTitle', { name: editing.preferredUsername })}
          save={async (fields) => {
            const updated = await api.updateAgentProfile(editing.id, fields);
            setAgents((list) => list?.map((x) => (x.id === updated.id ? updated : x)) ?? null);
            return asProfile(updated);
          }}
          onUpdate={() => {}}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
