// SPDX-License-Identifier: Hippocratic-3.0
import type { ChannelView, DMConversation, ActorProfile } from '@babelr/shared';

interface ChannelSidebarProps {
  mode: 'channels' | 'dms';
  serverName?: string;
  channels: ChannelView[];
  selectedChannelId: string | null;
  conversations: DMConversation[];
  selectedDMId: string | null;
  actor: ActorProfile;
  onSelectChannel: (id: string) => void;
  onSelectDM: (id: string) => void;
  onCreateChannel: () => void;
  onNewDM: () => void;
}

export function ChannelSidebar({
  mode,
  serverName,
  channels,
  selectedChannelId,
  conversations,
  selectedDMId,
  actor,
  onSelectChannel,
  onSelectDM,
  onCreateChannel,
  onNewDM,
}: ChannelSidebarProps) {
  if (mode === 'dms') {
    return (
      <div className="channel-sidebar">
        <div className="sidebar-header">Direct Messages</div>
        <div className="sidebar-list">
          <button className="sidebar-item add-channel" onClick={onNewDM}>
            + New message
          </button>
          {conversations.length === 0 && (
            <div className="sidebar-empty">No conversations yet</div>
          )}
          {conversations.map((dm) => {
            const otherParticipants = dm.participants.filter((p) => p.id !== actor.id);
            const name =
              otherParticipants.map((p) => p.displayName ?? p.preferredUsername).join(', ') ||
              'Unknown';
            return (
              <button
                key={dm.id}
                className={`sidebar-item ${selectedDMId === dm.id ? 'active' : ''}`}
                onClick={() => onSelectDM(dm.id)}
              >
                <span className="sidebar-item-name">{name}</span>
                {dm.lastMessage && (
                  <span className="sidebar-item-preview">
                    {dm.lastMessage.content.slice(0, 30)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="channel-sidebar">
      <div className="sidebar-header">{serverName ?? 'Server'}</div>
      <div className="sidebar-list">
        {channels.map((ch) => (
          <button
            key={ch.id}
            className={`sidebar-item ${selectedChannelId === ch.id ? 'active' : ''}`}
            onClick={() => onSelectChannel(ch.id)}
          >
            <span className="sidebar-item-name"># {ch.name}</span>
          </button>
        ))}
        <button className="sidebar-item add-channel" onClick={onCreateChannel}>
          + Create channel
        </button>
      </div>
    </div>
  );
}
