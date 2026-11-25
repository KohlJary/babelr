// SPDX-License-Identifier: MIT
import { useState } from 'react';
import type { ChannelView, DMConversation, ActorProfile, HouseMember } from '@babelr/shared';
import { useT } from '../i18n/I18nProvider';

interface ChannelSidebarProps {
  mode: 'channels' | 'dms';
  /** Decrypted last-message previews by DM id (E2E DMs are decrypted in ChatView). */
  dmPreviews?: Record<string, string>;
  serverName?: string;
  serverTagline?: string | null;
  channels: ChannelView[];
  selectedChannelId: string | null;
  conversations: DMConversation[];
  /** The house's daemons (GET /house), listed whether or not there's a DM yet. */
  houseAgents?: HouseMember[];
  /** Open (or start) the DM with a member. */
  onTalkTo?: (actorId: string) => void;
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
  /** View entries auto-generated from the view registry. Each entry
   *  has already been filtered by isAvailable. */
  viewEntries?: Array<{
    id: string;
    label: string;
    icon?: import('react').ReactNode;
    everywhere?: boolean;
  }>;
  onOpenView?: (id: string) => void;
  /** Rendered content from the plugin sidebar-slot registry. ChatView
   *  builds this; the sidebar just slots it in below the built-in
   *  buttons so plugin entries appear in the same toolbar stack. */
  pluginSlots?: import('react').ReactNode;
  onJoinVoice?: (channelId: string) => void;
  activeVoiceChannelId?: string | null;
  onLeaveServer?: () => void;
}

export function ChannelSidebar({
  mode,
  serverName,
  serverTagline,
  channels,
  selectedChannelId,
  conversations,
  houseAgents,
  onTalkTo,
  dmPreviews,
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
  viewEntries,
  onOpenView,
  pluginSlots,
  onJoinVoice,
  activeVoiceChannelId,
  onLeaveServer,
}: ChannelSidebarProps) {
  const t = useT();
  // Hooks stay above the DM-mode early return: switching from DMs to a
  // server must not change the number of hooks this component calls.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  if (mode === 'dms') {
    // Agents (daemons, builders) first: talking with them is half of what Babelr is for.
    // `kind` is stamped by the server from the actor row, so it can't be claimed.
    const others = (dm: DMConversation) => dm.participants.filter((p) => p.id !== actor.id);
    const isAgentDM = (dm: DMConversation) => others(dm).some((p) => p.kind);
    const agentDMs = conversations.filter(isAgentDM);
    const peopleDMs = conversations.filter((dm) => !isAgentDM(dm));
    // The House (Kohl, 2026-11-23: "merge the views"): every daemon who lives
    // here, with what she's doing now, whether or not you've talked yet; then
    // agents you have DMs with that aren't in the house; then people.
    const dmWith = (id: string) =>
      agentDMs.find((dm) => others(dm).length === 1 && others(dm)[0].id === id);
    const houseIds = new Set((houseAgents ?? []).map((m) => m.id));
    const otherAgentDMs = agentDMs.filter((dm) => !others(dm).some((p) => houseIds.has(p.id)));
    const renderMember = (m: HouseMember) => {
      const dm = dmWith(m.id);
      const name = m.displayName ?? m.preferredUsername;
      const line = m.now?.text ?? (dm ? preview(dm) : null) ?? m.summary;
      return (
        <button
          key={m.id}
          className={`sidebar-item sidebar-dm ${dm && selectedDMId === dm.id ? 'active' : ''}`}
          onClick={() => (dm ? onSelectDM(dm.id) : onTalkTo?.(m.id))}
        >
          <span className="sidebar-item-name">
            {name}
            {m.sigil && <span className="sidebar-sigil"> {m.sigil}</span>}
            {dm?.request?.state === 'pending' && dm.request.incoming && (
              <span className="dm-request-badge">{t('dm.requestBadge')}</span>
            )}
          </span>
          {line && (
            <span className="sidebar-item-preview">
              {m.now ? '⊙ ' : ''}
              {line.slice(0, 60)}
            </span>
          )}
        </button>
      );
    };
    const preview = (dm: DMConversation): string | null => {
      if (!dm.lastMessage) return null;
      if (dm.lastMessage.properties?.encrypted) {
        return dmPreviews?.[dm.id] ?? t('channelSidebar.encryptedPreview');
      }
      return dm.lastMessage.content;
    };
    const renderDM = (dm: DMConversation) => {
      const other = others(dm);
      const name = other.map((p) => p.displayName ?? p.preferredUsername).join(', ') || 'Unknown';
      const text = preview(dm);
      return (
        <button
          key={dm.id}
          className={`sidebar-item sidebar-dm ${selectedDMId === dm.id ? 'active' : ''}`}
          onClick={() => onSelectDM(dm.id)}
        >
          <span className="sidebar-item-name">
            {name}
            {dm.request?.state === 'pending' && dm.request.incoming && (
              <span className="dm-request-badge">{t('dm.requestBadge')}</span>
            )}
          </span>
          {text && <span className="sidebar-item-preview">{text.slice(0, 60)}</span>}
        </button>
      );
    };
    return (
      <div className="channel-sidebar">
        <div className="sidebar-header">{t('channelSidebar.theHouse')}</div>
        <div className="sidebar-list">
          <button className="sidebar-item add-channel" onClick={onNewDM}>
            {t('channelSidebar.newMessage')}
          </button>
          {onShowFriends && (
            <button className="sidebar-item add-channel" onClick={onShowFriends}>
              {t('channelSidebar.friends')}
            </button>
          )}
          {(viewEntries ?? []).some((v) => v.everywhere) && (
            <div className="sidebar-section-label">{t('channelSidebar.house')}</div>
          )}
          {viewEntries
            ?.filter((v) => v.everywhere)
            .map((v) => (
              <button
                key={v.id}
                className="sidebar-item add-channel"
                onClick={() => onOpenView?.(v.id)}
              >
                {v.icon && <span className="sidebar-view-icon">{v.icon}</span>}
                {v.label}
              </button>
            ))}
          {conversations.length === 0 && !houseAgents?.length && (
            <div className="sidebar-empty">{t('channelSidebar.noConversations')}</div>
          )}
          {(houseAgents?.length ?? 0) + otherAgentDMs.length > 0 && (
            <div className="sidebar-section-label">{t('channelSidebar.daemons')}</div>
          )}
          {(houseAgents ?? []).map(renderMember)}
          {otherAgentDMs.map(renderDM)}
          {peopleDMs.length > 0 && (
            <div className="sidebar-section-label">{t('channelSidebar.people')}</div>
          )}
          {peopleDMs.map(renderDM)}
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
            // Voice channels: select AND join. Selecting is what makes
            // ChatView render the full-size CallView; joining is the
            // actual mediasoup entry. Both happen on the same click.
            onSelectChannel(ch.id);
            if (isVoice && onJoinVoice) onJoinVoice(ch.id);
          }}
        >
          <span className="sidebar-item-name">
            {icon}
            {ch.name}
          </span>
          {unreadCount > 0 && !isMuted && !isVoice && (
            <span className="unread-badge">{unreadCount}</span>
          )}
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
        {viewEntries?.map((v) => (
          <button
            key={v.id}
            className="sidebar-item add-channel"
            onClick={() => onOpenView?.(v.id)}
          >
            {v.icon && <span className="sidebar-view-icon">{v.icon}</span>}
            {v.label}
          </button>
        ))}
        {pluginSlots}
        {onShowServerSettings && (
          <button className="sidebar-item add-channel" onClick={onShowServerSettings}>
            {t('channelSidebar.serverSettings')}
          </button>
        )}
        {/* Audit log is now a tab within server settings — no standalone button. */}
        {onLeaveServer && (
          <button
            className="sidebar-item add-channel"
            style={{ color: '#ef4444' }}
            onClick={() => {
              if (window.confirm(t('channelSidebar.leaveConfirm'))) {
                onLeaveServer();
              }
            }}
          >
            {t('channelSidebar.leaveServer')}
          </button>
        )}
      </div>
    </div>
  );
}
