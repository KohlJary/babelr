// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect } from 'react';
import type { ActorProfile, ServerView } from '@babelr/shared';
import { SUPPORTED_LANGUAGES } from '@babelr/shared';
import * as api from '../api';
import { useT } from '../i18n/I18nProvider';

interface OnboardingWizardProps {
  actor: ActorProfile;
  onComplete: (actor: ActorProfile) => void;
}

type Step = 'profile' | 'language' | 'server' | 'embeds' | 'done';

function detectBrowserLanguage(): string {
  const nav = navigator.language?.slice(0, 2).toLowerCase();
  if (nav && (SUPPORTED_LANGUAGES as readonly string[]).includes(nav)) return nav;
  return 'en';
}

export function OnboardingWizard({ actor, onComplete }: OnboardingWizardProps) {
  const t = useT();
  const [step, setStep] = useState<Step>('profile');
  const [displayName, setDisplayName] = useState(actor.displayName ?? '');
  const [language, setLanguage] = useState(actor.preferredLanguage || detectBrowserLanguage());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Server step state
  const [serverMode, setServerMode] = useState<'create' | 'join'>('create');
  const [serverName, setServerName] = useState('');
  const [discoverable, setDiscoverable] = useState<api.DiscoverableServer[]>([]);
  const [joiningId, setJoiningId] = useState<string | null>(null);

  const [currentActor, setCurrentActor] = useState(actor);

  useEffect(() => {
    if (step === 'server') {
      api.discoverServers().then(setDiscoverable).catch(() => {});
    }
  }, [step]);

  const handleProfileNext = async () => {
    if (!displayName.trim()) {
      setError('Please enter a display name');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateProfile({ displayName: displayName.trim() });
      setCurrentActor(updated);
      setStep('language');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleLanguageNext = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateProfile({ preferredLanguage: language });
      setCurrentActor(updated);
      setStep('server');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleCreateServer = async () => {
    if (!serverName.trim()) {
      setError('Please enter a server name');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.createServer({ name: serverName.trim() });
      setStep('embeds');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleJoinServer = async (server: ServerView) => {
    setJoiningId(server.id);
    setError(null);
    try {
      await api.joinServer(server.id);
      setStep('embeds');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setJoiningId(null);
    }
  };

  const handleFinish = () => {
    onComplete(currentActor);
  };

  const steps: Step[] = ['profile', 'language', 'server', 'embeds', 'done'];
  const stepIndex = steps.indexOf(step);

  return (
    <div className="onboarding-overlay">
      <div className="onboarding-card">
        <div className="onboarding-progress">
          {steps.map((s, i) => (
            <div
              key={s}
              className={`onboarding-progress-dot${i <= stepIndex ? ' active' : ''}`}
            />
          ))}
        </div>

        {step === 'profile' && (
          <div className="onboarding-step">
            <h2>{t('onboarding.welcome')}</h2>
            <p className="onboarding-subtitle">{t('onboarding.profileSubtitle')}</p>
            <label className="onboarding-field">
              <span>{t('onboarding.displayName')}</span>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={actor.preferredUsername}
                autoFocus
                maxLength={64}
              />
            </label>
            {error && <div className="onboarding-error">{error}</div>}
            <div className="onboarding-actions">
              <button
                type="button"
                className="onboarding-btn primary"
                disabled={saving || !displayName.trim()}
                onClick={() => void handleProfileNext()}
              >
                {saving ? t('onboarding.saving') : t('onboarding.next')}
              </button>
            </div>
          </div>
        )}

        {step === 'language' && (
          <div className="onboarding-step">
            <h2>{t('onboarding.chooseLanguage')}</h2>
            <p className="onboarding-subtitle">{t('onboarding.languageSubtitle')}</p>
            <select
              className="onboarding-language-select"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
            >
              {SUPPORTED_LANGUAGES.map((code) => (
                <option key={code} value={code}>
                  {t(`language.${code}` as 'language.en')}
                </option>
              ))}
            </select>
            {error && <div className="onboarding-error">{error}</div>}
            <div className="onboarding-actions">
              <button
                type="button"
                className="onboarding-btn secondary"
                onClick={() => setStep('profile')}
              >
                {t('onboarding.back')}
              </button>
              <button
                type="button"
                className="onboarding-btn primary"
                disabled={saving}
                onClick={() => void handleLanguageNext()}
              >
                {saving ? t('onboarding.saving') : t('onboarding.next')}
              </button>
            </div>
          </div>
        )}

        {step === 'server' && (
          <div className="onboarding-step">
            <h2>{t('onboarding.setupServer')}</h2>
            <p className="onboarding-subtitle">{t('onboarding.serverSubtitle')}</p>

            <div className="onboarding-server-tabs">
              <button
                type="button"
                className={`onboarding-tab${serverMode === 'create' ? ' active' : ''}`}
                onClick={() => setServerMode('create')}
              >
                {t('onboarding.createServer')}
              </button>
              <button
                type="button"
                className={`onboarding-tab${serverMode === 'join' ? ' active' : ''}`}
                onClick={() => setServerMode('join')}
              >
                {t('onboarding.joinServer')}
              </button>
            </div>

            {serverMode === 'create' && (
              <div className="onboarding-server-form">
                <label className="onboarding-field">
                  <span>{t('onboarding.serverName')}</span>
                  <input
                    type="text"
                    value={serverName}
                    onChange={(e) => setServerName(e.target.value)}
                    placeholder={t('onboarding.serverNamePlaceholder')}
                    autoFocus
                    maxLength={100}
                  />
                </label>
                {error && <div className="onboarding-error">{error}</div>}
                <div className="onboarding-actions">
                  <button
                    type="button"
                    className="onboarding-btn secondary"
                    onClick={() => setStep('language')}
                  >
                    {t('onboarding.back')}
                  </button>
                  <button
                    type="button"
                    className="onboarding-btn primary"
                    disabled={saving || !serverName.trim()}
                    onClick={() => void handleCreateServer()}
                  >
                    {saving ? t('onboarding.creating') : t('onboarding.create')}
                  </button>
                </div>
              </div>
            )}

            {serverMode === 'join' && (
              <div className="onboarding-server-list">
                {discoverable.filter((s) => !s.joined).length === 0 ? (
                  <div className="onboarding-empty">
                    {t('onboarding.noServersToJoin')}
                  </div>
                ) : (
                  discoverable
                    .filter((s) => !s.joined)
                    .map((server) => (
                      <div key={server.id} className="onboarding-server-row">
                        <div className="onboarding-server-info">
                          <span className="onboarding-server-name">{server.name}</span>
                          {server.tagline && (
                            <span className="onboarding-server-tagline">
                              {server.tagline}
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          className="onboarding-btn small"
                          disabled={joiningId === server.id}
                          onClick={() => void handleJoinServer(server)}
                        >
                          {joiningId === server.id
                            ? t('onboarding.joining')
                            : t('onboarding.join')}
                        </button>
                      </div>
                    ))
                )}
                {error && <div className="onboarding-error">{error}</div>}
                <div className="onboarding-actions">
                  <button
                    type="button"
                    className="onboarding-btn secondary"
                    onClick={() => setStep('language')}
                  >
                    {t('onboarding.back')}
                  </button>
                </div>
              </div>
            )}

            <button
              type="button"
              className="onboarding-skip"
              onClick={() => setStep('embeds')}
            >
              {t('onboarding.skipForNow')}
            </button>
          </div>
        )}

        {step === 'embeds' && (
          <div className="onboarding-step">
            <h2>{t('onboarding.embedsTitle')}</h2>
            <p className="onboarding-subtitle">{t('onboarding.embedsSubtitle')}</p>

            <div className="onboarding-embed-examples">
              <div className="onboarding-embed-example">
                <code className="onboarding-embed-syntax">[[page:meeting-notes]]</code>
                <span className="onboarding-embed-desc">{t('onboarding.embedPage')}</span>
              </div>
              <div className="onboarding-embed-example">
                <code className="onboarding-embed-syntax">[[event:team-standup]]</code>
                <span className="onboarding-embed-desc">{t('onboarding.embedEvent')}</span>
              </div>
              <div className="onboarding-embed-example">
                <code className="onboarding-embed-syntax">[[task:fix-login-bug]]</code>
                <span className="onboarding-embed-desc">{t('onboarding.embedTask')}</span>
              </div>
              <div className="onboarding-embed-example">
                <code className="onboarding-embed-syntax">[[file:quarterly-report]]</code>
                <span className="onboarding-embed-desc">{t('onboarding.embedFile')}</span>
              </div>
            </div>

            <div className="onboarding-embed-note">
              <p>{t('onboarding.embedsHow')}</p>
              <p>{t('onboarding.embedsCrossTower')}</p>
            </div>

            <div className="onboarding-actions">
              <button
                type="button"
                className="onboarding-btn secondary"
                onClick={() => setStep('server')}
              >
                {t('onboarding.back')}
              </button>
              <button
                type="button"
                className="onboarding-btn primary"
                onClick={() => setStep('done')}
              >
                {t('onboarding.next')}
              </button>
            </div>
          </div>
        )}

        {step === 'done' && (
          <div className="onboarding-step onboarding-done">
            <h2>{t('onboarding.allSet')}</h2>
            <p className="onboarding-subtitle">{t('onboarding.doneSubtitle')}</p>
            <div className="onboarding-actions">
              <button
                type="button"
                className="onboarding-btn primary"
                onClick={handleFinish}
              >
                {t('onboarding.getStarted')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
