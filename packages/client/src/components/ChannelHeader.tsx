// SPDX-License-Identifier: Hippocratic-3.0
import type { ActorProfile } from '@babelr/shared';

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
  return (
    <header className="channel-header">
      <div className="channel-info">
        <div className="channel-info-top">
          <span className="channel-name">
            {encrypted && <span className="e2e-lock" title="End-to-end encrypted">&#128274; </span>}
            {channelName}
          </span>
          <span className={`connection-status ${connected ? 'online' : 'offline'}`}>
            {connected ? 'connected' : 'reconnecting...'}
          </span>
        </div>
        {channelTopic && <span className="channel-topic">{channelTopic}</span>}
      </div>
      <div className="user-info">
        <button className="username-btn" onClick={onOpenProfile} title="Edit profile">
          {actor.displayName ?? actor.preferredUsername}
        </button>
        <button className="settings-btn" onClick={onOpenMentions} title="Mentions">
          @
        </button>
        <button className="settings-btn" onClick={onOpenSettings} title="Settings">
          &#9881;
        </button>
        <button className="logout-btn" onClick={onLogout}>
          Log out
        </button>
      </div>
    </header>
  );
}
