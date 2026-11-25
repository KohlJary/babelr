// SPDX-License-Identifier: MIT
import { useState } from 'react';
import type { ActorProfile } from '@babelr/shared';
import { useT } from '../i18n/I18nProvider';

interface ChannelHeaderProps {
  channelName: string;
  channelTopic?: string | null;
  actor: ActorProfile;
  connected: boolean;
  encrypted?: boolean;
  onLogout: () => void;
  onOpenSettings: () => void;
  onOpenProfile: () => void;
  onOpenMentions: () => void;
  onOpenPins?: () => void;
  pinCount?: number;
  /** Phones: the conversation list is a drawer; this reopens it. */
  onOpenDrawer?: () => void;
  /** Phones: a daemon DM's room opens from this labeled button (desktop has the side rail). */
  onOpenRoom?: () => void;
  roomLabel?: string;
}

export function ChannelHeader({
  channelName,
  channelTopic,
  actor,
  connected,
  encrypted,
  onOpenDrawer,
  onLogout,
  onOpenSettings,
  onOpenProfile,
  onOpenMentions,
  onOpenPins,
  pinCount,
  onOpenRoom,
  roomLabel,
}: ChannelHeaderProps) {
  const t = useT();
  // Phones (stopgap): the header keeps ☰, the name and a ⋯ menu; the
  // inline buttons move into the menu. Hidden by CSS above 768px.
  const [menuOpen, setMenuOpen] = useState(false);
  const pick = (fn: () => void) => () => {
    setMenuOpen(false);
    fn();
  };
  return (
    <header className="channel-header">
      {onOpenDrawer && (
        <button
          type="button"
          className="drawer-toggle"
          aria-label={t('channelHeader.openDrawer')}
          title={t('channelHeader.openDrawer')}
          onClick={onOpenDrawer}
        >
          ☰
        </button>
      )}
      <div className="channel-info">
        <div className="channel-info-top">
          <span className="channel-name">
            {encrypted && (
              <span className="e2e-lock" title={t('channelHeader.encrypted')}>
                &#128274;{' '}
              </span>
            )}
            {channelName}
          </span>
          <span className={`connection-status ${connected ? 'online' : 'offline'}`}>
            {connected ? t('channelHeader.connected') : t('channelHeader.reconnecting')}
          </span>
        </div>
        {channelTopic && <span className="channel-topic">{channelTopic}</span>}
      </div>
      <div className="user-info">
        <button
          className="username-btn"
          onClick={onOpenProfile}
          title={t('channelHeader.editProfile')}
        >
          {actor.displayName ?? actor.preferredUsername}
        </button>
        {onOpenPins && (
          <button className="settings-btn" onClick={onOpenPins} title="Pinned messages">
            📌{pinCount ? ` ${pinCount}` : ''}
          </button>
        )}
        <button
          className="settings-btn"
          onClick={onOpenMentions}
          title={t('channelHeader.mentions')}
        >
          @
        </button>
        <button
          className="settings-btn"
          onClick={onOpenSettings}
          title={t('channelHeader.settings')}
        >
          &#9881;
        </button>
        <button className="logout-btn" onClick={onLogout}>
          {t('channelHeader.logout')}
        </button>
      </div>
      {onOpenRoom && (
        <button type="button" className="header-room-btn" onClick={onOpenRoom}>
          {roomLabel ?? t('channelHeader.room')}
        </button>
      )}
      <div className="header-more">
        <button
          type="button"
          className="header-more-btn"
          aria-label={t('channelHeader.more')}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
        >
          ⋯
        </button>
        {menuOpen && (
          <>
            <div className="header-more-scrim" onClick={() => setMenuOpen(false)} />
            <div className="header-more-menu" role="menu">
              {onOpenPins && (
                <button type="button" role="menuitem" onClick={pick(onOpenPins)}>
                  📌 {t('pins.title')}
                  {pinCount ? ` (${pinCount})` : ''}
                </button>
              )}
              <button type="button" role="menuitem" onClick={pick(onOpenMentions)}>
                @ {t('channelHeader.mentions')}
              </button>
              <button type="button" role="menuitem" onClick={pick(onOpenSettings)}>
                ⚙ {t('channelHeader.settings')}
              </button>
              <div className="header-more-status">
                {actor.displayName ?? actor.preferredUsername} ·{' '}
                {connected ? t('channelHeader.connected') : t('channelHeader.reconnecting')}
              </div>
              <button
                type="button"
                role="menuitem"
                className="header-more-logout"
                onClick={pick(onLogout)}
              >
                {t('channelHeader.logout')}
              </button>
            </div>
          </>
        )}
      </div>
    </header>
  );
}
