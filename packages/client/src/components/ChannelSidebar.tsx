// SPDX-License-Identifier: Hippocratic-3.0
import { useState } from 'react';
import type { ChannelView, DMConversation, ActorProfile } from '@babelr/shared';

interface ChannelSidebarProps {
  mode: 'channels' | 'dms';
  serverName?: string;
  channels: ChannelView[];
  selectedChannelId: string | null;
  conversations: DMConversation[];
  selectedDMId: string | null;
  actor: ActorProfile;
  unreadCounts?: Map<string, number>;
  onSelectChannel: (id: string) => void;
  onSelectDM: (id: string) => void;
  onCreateChannel: () => void;
  onNewDM: () => void;
  onShowMembers: () => void;
  onShowGlossary: () => void;
  onShowServerSettings?: () => void;
}

export function ChannelSidebar({
  mode,
  serverName,
  channels,
  selectedChannelId,
  conversations,
  selectedDMId,
  actor,
  unreadCounts,
  onSelectChannel,
  onSelectDM,
  onCreateChannel,
  onNewDM,
  onShowMembers,
  onShowGlossary,
  onShowServerSettings,
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

  // Group channels by category
  const categorized = new Map<string, ChannelView[]>();
  const uncategorized: ChannelView[] = [];
  for (const ch of channels) {
    if (ch.category) {
      const list = categorized.get(ch.category) ?? [];
      list.push(ch);
      categorized.set(ch.category, list);
    } else {
      uncategorized.push(ch);
    }
  }

  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const toggleCategory = (cat: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const renderChannel = (ch: ChannelView) => {
    const unreadCount = unreadCounts?.get(ch.id) ?? 0;
    return (
      <button
        key={ch.id}
        className={`sidebar-item ${selectedChannelId === ch.id ? 'active' : ''}`}
        onClick={() => onSelectChannel(ch.id)}
      >
        <span className="sidebar-item-name">{ch.isPrivate ? '\uD83D\uDD12 ' : '# '}{ch.name}</span>
        {unreadCount > 0 && <span className="unread-badge">{unreadCount}</span>}
      </button>
    );
  };

  return (
    <div className="channel-sidebar">
      <div className="sidebar-header">{serverName ?? 'Server'}</div>
      <div className="sidebar-list">
        {Array.from(categorized.entries()).map(([cat, chs]) => (
          <div key={cat} className="channel-category">
            <button className="category-header" onClick={() => toggleCategory(cat)}>
              <span className="category-arrow">{collapsed.has(cat) ? '\u25B6' : '\u25BC'}</span>
              <span className="category-name">{cat}</span>
            </button>
            {!collapsed.has(cat) && chs.map(renderChannel)}
          </div>
        ))}
        {uncategorized.map(renderChannel)}
        <button className="sidebar-item add-channel" onClick={onCreateChannel}>
          + Create channel
        </button>
        <button className="sidebar-item add-channel" onClick={onShowMembers}>
          Members
        </button>
        <button className="sidebar-item add-channel" onClick={onShowGlossary}>
          Glossary
        </button>
        {onShowServerSettings && (
          <button className="sidebar-item add-channel" onClick={onShowServerSettings}>
            Server Settings
          </button>
        )}
      </div>
    </div>
  );
}
