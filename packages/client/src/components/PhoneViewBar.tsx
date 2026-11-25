// SPDX-License-Identifier: MIT
import { useT } from '../i18n/I18nProvider';

/**
 * Phones (stopgap until the shell restructure): a slim bar over a full view
 * (Calendar, Wiki, Mentions, a plugin view...) with the ☰ that reopens the
 * conversation list, so no view is a dead end with only its ×. Hidden by CSS
 * above 768px.
 */
export function PhoneViewBar({ onOpenDrawer }: { onOpenDrawer: () => void }) {
  const t = useT();
  return (
    <div className="phone-view-bar">
      <button type="button" className="phone-view-bar-btn" onClick={onOpenDrawer}>
        <span aria-hidden="true">☰</span> {t('channelHeader.openDrawer')}
      </button>
    </div>
  );
}
