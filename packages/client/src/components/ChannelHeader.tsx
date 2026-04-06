// SPDX-License-Identifier: Hippocratic-3.0
import type { ActorProfile } from '@babelr/shared';

interface ChannelHeaderProps {
  channelName: string;
  actor: ActorProfile;
  connected: boolean;
  onLogout: () => void;
  onOpenSettings: () => void;
}

export function ChannelHeader({
  channelName,
  actor,
  connected,
  onLogout,
  onOpenSettings,
}: ChannelHeaderProps) {
  return (
    <header className="channel-header">
      <div className="channel-info">
        <span className="channel-name">{channelName}</span>
        <span className={`connection-status ${connected ? 'online' : 'offline'}`}>
          {connected ? 'connected' : 'reconnecting...'}
        </span>
      </div>
      <div className="user-info">
        <span className="username">{actor.preferredUsername}</span>
        <button className="settings-btn" onClick={onOpenSettings} title="Translation settings">
          &#9881;
        </button>
        <button className="logout-btn" onClick={onLogout}>
          Log out
        </button>
      </div>
    </header>
  );
}
