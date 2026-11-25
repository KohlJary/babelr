// SPDX-License-Identifier: MIT
import { useEffect, useState } from 'react';
import { useT } from '../i18n/I18nProvider';

/** Says the account is over its request budget, and counts down to when
 *  Babelr will try again on its own (FINDINGS #73). */
export function RateLimitBanner({ until }: { until: number }) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [until]);
  if (!until) return null;
  const seconds = Math.max(1, Math.ceil((until - now) / 1000));
  return (
    <div className="rate-limit-banner" role="status" aria-live="polite">
      <strong>{t('rateLimit.title')}</strong> {t('rateLimit.body', { seconds: String(seconds) })}
    </div>
  );
}
