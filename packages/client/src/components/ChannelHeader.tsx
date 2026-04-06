// SPDX-License-Identifier: Hippocratic-3.0
import type { ActorProfile, ChannelView } from '@babelr/shared';

interface ChannelHeaderProps {
  channel: ChannelView | null;
  actor: ActorProfile;
  connected: boolean;
  onLogout: () => void;
  onOpenSettings: () => void;
}

export function ChannelHeader({
  channel,
  actor,
  connected,
  onLogout,
  onOpenSettings,
}: ChannelHeaderProps) {
  return (
    <header className="channel-header">
      <div className="channel-info">
        <span className="channel-name"># {channel?.name ?? '...'}</span>
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
