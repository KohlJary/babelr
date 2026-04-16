// SPDX-License-Identifier: Hippocratic-3.0
import { useState } from 'react';
import * as api from '../api';
import { useT } from '../i18n/I18nProvider';

export function VerificationBanner() {
  const t = useT();
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const handleResend = async () => {
    setSending(true);
    try {
      await api.resendVerification();
      setSent(true);
    } catch {
      // non-fatal
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="verification-banner">
      <span className="verification-banner-text">
        {t('verification.banner')}
      </span>
      {sent ? (
        <span className="verification-banner-sent">
          {t('verification.sent')}
        </span>
      ) : (
        <button
          type="button"
          className="verification-banner-btn"
          disabled={sending}
          onClick={() => void handleResend()}
        >
          {sending ? t('verification.sending') : t('verification.resend')}
        </button>
      )}
    </div>
  );
}
