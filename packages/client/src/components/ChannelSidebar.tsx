// SPDX-License-Identifier: Hippocratic-3.0
import { useState } from 'react';
import type { ChannelView, DMConversation, ActorProfile } from '@babelr/shared';
import { useT } from '../i18n/I18nProvider';

interface ChannelSidebarProps {
  mode: 'channels' | 'dms';
  serverName?: string;
  serverTagline?: string | null;
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
  mutedChannels?: Set<string>;
  onToggleMute?: (channelId: string, muted: boolean) => void;
  selectedChannelIsPrivate?: boolean;
  onInviteToChannel?: () => void;
  onShowFriends?: () => void;
  canManageChannels?: boolean;
  onEditChannel?: (channelId: string) => void;
  onShowCalendar?: () => void;
  onJoinVoice?: (channelId: string) => void;
  activeVoiceChannelId?: string | null;
}

export function ChannelSidebar({
  mode,
  serverName,
  serverTagline,
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
  mutedChannels,
  onToggleMute,
  selectedChannelIsPrivate,
  onInviteToChannel,
  onShowFriends,
  canManageChannels,
  onEditChannel,
  onShowCalendar,
  onJoinVoice,
  activeVoiceChannelId,
}: ChannelSidebarProps) {
  const t = useT();
  if (mode === 'dms') {
    return (
      <div className="channel-sidebar">
        <div className="sidebar-header">{t('channelSidebar.directMessages')}</div>
        <div className="sidebar-list">
          <button className="sidebar-item add-channel" onClick={onNewDM}>
            {t('channelSidebar.newMessage')}
          </button>
          {onShowFriends && (
            <button className="sidebar-item add-channel" onClick={onShowFriends}>
              {t('channelSidebar.friends')}
            </button>
          )}
          {onShowCalendar && (
            <button className="sidebar-item add-channel" onClick={onShowCalendar}>
              {t('events.title')}
            </button>
          )}
          {conversations.length === 0 && (
            <div className="sidebar-empty">{t('channelSidebar.noConversations')}</div>
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
    const isMuted = mutedChannels?.has(ch.id) ?? false;
    const isVoice = ch.channelType === 'voice';
    const isActiveVoice = isVoice && activeVoiceChannelId === ch.id;
    const icon = isVoice ? '\uD83D\uDD0A ' : ch.isPrivate ? '\uD83D\uDD12 ' : '# ';
    return (
      <div key={ch.id} className={`sidebar-channel-row ${isMuted ? 'muted' : ''}`}>
        <button
          className={`sidebar-item ${selectedChannelId === ch.id ? 'active' : ''} ${isActiveVoice ? 'voice-active' : ''}`}
          onClick={() => {
            if (isVoice && onJoinVoice) onJoinVoice(ch.id);
            else onSelectChannel(ch.id);
          }}
        >
          <span className="sidebar-item-name">{icon}{ch.name}</span>
          {unreadCount > 0 && !isMuted && !isVoice && <span className="unread-badge">{unreadCount}</span>}
        </button>
        {onToggleMute && (
          <button
            className="channel-mute-btn"
            onClick={() => onToggleMute(ch.id, !isMuted)}
            title={isMuted ? t('channelSidebar.unmuteChannel') : t('channelSidebar.muteChannel')}
          >
            {isMuted ? '\uD83D\uDD15' : '\uD83D\uDD14'}
          </button>
        )}
        {canManageChannels && onEditChannel && (
          <button
            className="channel-settings-btn"
            onClick={() => onEditChannel(ch.id)}
            title={t('channelSidebar.channelSettingsTitle')}
          >
            {'\u2699\uFE0F'}
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="channel-sidebar">
      <div className="sidebar-header">
        <span className="sidebar-header-name">{serverName ?? 'Server'}</span>
        {serverTagline && <span className="sidebar-header-tagline">{serverTagline}</span>}
      </div>
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
          {t('channelSidebar.createChannel')}
        </button>
        <button className="sidebar-item add-channel" onClick={onShowMembers}>
          {t('channelSidebar.members')}
        </button>
        <button className="sidebar-item add-channel" onClick={onShowGlossary}>
          {t('channelSidebar.glossary')}
        </button>
        {selectedChannelIsPrivate && onInviteToChannel && (
          <button className="sidebar-item add-channel" onClick={onInviteToChannel}>
            {t('channelSidebar.inviteToChannel')}
          </button>
        )}
        {onShowCalendar && (
          <button className="sidebar-item add-channel" onClick={onShowCalendar}>
            {t('events.title')}
          </button>
        )}
        {onShowServerSettings && (
          <button className="sidebar-item add-channel" onClick={onShowServerSettings}>
            {t('channelSidebar.serverSettings')}
          </button>
        )}
      </div>
    </div>
  );
}
