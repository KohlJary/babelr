// SPDX-License-Identifier: Hippocratic-3.0
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
}

export function ChannelHeader({
  channelName,
  channelTopic,
  actor,
  connected,
  encrypted,
  onLogout,
  onOpenSettings,
  onOpenProfile,
  onOpenMentions,
}: ChannelHeaderProps) {
  const t = useT();
  return (
    <header className="channel-header">
      <div className="channel-info">
        <div className="channel-info-top">
          <span className="channel-name">
            {encrypted && <span className="e2e-lock" title={t('channelHeader.encrypted')}>&#128274; </span>}
            {channelName}
          </span>
          <span className={`connection-status ${connected ? 'online' : 'offline'}`}>
            {connected ? t('channelHeader.connected') : t('channelHeader.reconnecting')}
          </span>
        </div>
        {channelTopic && <span className="channel-topic">{channelTopic}</span>}
      </div>
      <div className="user-info">
        <button className="username-btn" onClick={onOpenProfile} title={t('channelHeader.editProfile')}>
          {actor.displayName ?? actor.preferredUsername}
        </button>
        <button className="settings-btn" onClick={onOpenMentions} title={t('channelHeader.mentions')}>
          @
        </button>
        <button className="settings-btn" onClick={onOpenSettings} title={t('channelHeader.settings')}>
          &#9881;
        </button>
        <button className="logout-btn" onClick={onLogout}>
          {t('channelHeader.logout')}
        </button>
      </div>
    </header>
  );
}
