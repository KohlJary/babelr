// SPDX-License-Identifier: Hippocratic-3.0
import { useState } from 'react';
import type { ActorProfile } from '@babelr/shared';
import * as api from '../api';
import { useT } from '../i18n/I18nProvider';

interface TwoFactorSettingsProps {
  actor: ActorProfile;
  onActorUpdate?: (actor: ActorProfile) => void;
}

export function TwoFactorSettings({ actor, onActorUpdate }: TwoFactorSettingsProps) {
  const t = useT();
  const [phase, setPhase] = useState<'idle' | 'setup' | 'recovery' | 'disable'>('idle');
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [secretKey, setSecretKey] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleStartSetup = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const result = await api.setup2fa();
      setQrDataUrl(result.qrDataUrl);
      setSecretKey(result.secret);
      setPhase('setup');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmSetup = async () => {
    if (!code.trim()) return;
    setError(null);
    setSubmitting(true);
    try {
      const result = await api.verify2faSetup(code.trim());
      setRecoveryCodes(result.recoveryCodes);
      setPhase('recovery');
      const me = await api.getMe();
      onActorUpdate?.(me);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDisable = async () => {
    if (!code.trim()) return;
    setError(null);
    setSubmitting(true);
    try {
      await api.disable2fa(code.trim());
      setPhase('idle');
      setCode('');
      const me = await api.getMe();
      onActorUpdate?.(me);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  if (actor.totpEnabled && phase === 'idle') {
    return (
      <div className="settings-field tfa-settings">
        <label>{t('twoFactor.enabled')}</label>
        <button
          type="button"
          className="auth-submit"
          onClick={() => setPhase('disable')}
        >
          {t('twoFactor.disable')}
        </button>
        {phase === 'idle' && null}
      </div>
    );
  }

  if (phase === 'disable') {
    return (
      <div className="settings-field tfa-settings">
        <label>{t('twoFactor.disableConfirm')}</label>
        <input
          type="text"
          className="modal-input"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="000000"
          autoComplete="one-time-code"
          inputMode="numeric"
          maxLength={8}
        />
        {error && <div className="auth-error">{error}</div>}
        <div className="tfa-actions">
          <button
            type="button"
            className="auth-submit"
            disabled={submitting || !code.trim()}
            onClick={() => void handleDisable()}
          >
            {t('twoFactor.disable')}
          </button>
          <button
            type="button"
            className="settings-cancel-btn"
            onClick={() => {
              setPhase('idle');
              setCode('');
              setError(null);
            }}
          >
            {t('common.cancel')}
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'recovery') {
    return (
      <div className="settings-field tfa-settings">
        <label>{t('twoFactor.recoveryCodes')}</label>
        <p className="settings-hint">{t('twoFactor.recoveryWarning')}</p>
        <div className="tfa-recovery-codes">
          {recoveryCodes.map((c) => (
            <code key={c} className="tfa-recovery-code">
              {c}
            </code>
          ))}
        </div>
        <button
          type="button"
          className="auth-submit"
          onClick={() => {
            setPhase('idle');
            setCode('');
            setRecoveryCodes([]);
          }}
        >
          {t('twoFactor.done')}
        </button>
      </div>
    );
  }

  if (phase === 'setup') {
    return (
      <div className="settings-field tfa-settings">
        <label>{t('twoFactor.setupSubtitle')}</label>
        {qrDataUrl && (
          <img src={qrDataUrl} alt="TOTP QR code" className="tfa-qr" />
        )}
        {secretKey && (
          <div className="tfa-secret">
            <code>{secretKey}</code>
          </div>
        )}
        <input
          type="text"
          className="modal-input"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={t('twoFactor.enterCode')}
          autoComplete="one-time-code"
          inputMode="numeric"
          maxLength={6}
          autoFocus
        />
        {error && <div className="auth-error">{error}</div>}
        <div className="tfa-actions">
          <button
            type="button"
            className="auth-submit"
            disabled={submitting || !code.trim()}
            onClick={() => void handleConfirmSetup()}
          >
            {submitting ? t('twoFactor.confirming') : t('twoFactor.confirm')}
          </button>
          <button
            type="button"
            className="settings-cancel-btn"
            onClick={() => {
              setPhase('idle');
              setCode('');
              setError(null);
            }}
          >
            {t('common.cancel')}
          </button>
        </div>
      </div>
    );
  }

  // idle, not enabled
  return (
    <div className="settings-field tfa-settings">
      <label>{t('twoFactor.setup')}</label>
      {error && <div className="auth-error">{error}</div>}
      <button
        type="button"
        className="auth-submit"
        disabled={submitting}
        onClick={() => void handleStartSetup()}
      >
        {t('twoFactor.setup')}
      </button>
    </div>
  );
}
