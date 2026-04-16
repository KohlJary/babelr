// SPDX-License-Identifier: Hippocratic-3.0
import { useState } from 'react';
import { useT } from '../i18n/I18nProvider';

interface TwoFactorChallengeProps {
  onSubmit: (code: string) => Promise<void>;
  error: string | null;
}

export function TwoFactorChallenge({ onSubmit, error }: TwoFactorChallengeProps) {
  const t = useT();
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim() || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(code.trim());
    } catch {
      // error is surfaced via props.error
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-container">
      <h1>{t('twoFactor.title')}</h1>
      <p className="auth-subtitle">{t('twoFactor.subtitle')}</p>
      <form className="auth-form" onSubmit={(e) => void handleSubmit(e)}>
        <input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={t('twoFactor.codePlaceholder')}
          autoFocus
          autoComplete="one-time-code"
          inputMode="numeric"
          maxLength={8}
        />
        {error && <div className="auth-error">{error}</div>}
        <button type="submit" className="auth-submit" disabled={submitting || !code.trim()}>
          {submitting ? t('twoFactor.verifying') : t('twoFactor.verify')}
        </button>
        <p className="auth-hint">{t('twoFactor.recoveryHint')}</p>
      </form>
    </div>
  );
}
