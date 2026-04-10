// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect, useCallback } from 'react';
import type { ActorProfile, MessageWithAuthor } from '@babelr/shared';
import * as api from '../api';
import { useServers } from '../hooks/useServers';
import { useChannels } from '../hooks/useChannels';
import { useDMs } from '../hooks/useDMs';
import { useChat } from '../hooks/useChat';
import { useTranslationSettings } from '../hooks/useTranslationSettings';
import { useTranslation } from '../hooks/useTranslation';
import { useE2E } from '../hooks/useE2E';
import { useUnreadBadges } from '../hooks/useUnreadBadges';
import { ServerSidebar } from './ServerSidebar';
import { ChannelSidebar } from './ChannelSidebar';
import { ChannelHeader } from './ChannelHeader';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { SettingsPanel } from './SettingsPanel';
import { CreateServerModal } from './CreateServerModal';
import { CreateChannelModal } from './CreateChannelModal';
import { NewDMModal } from './NewDMModal';
import { MemberList } from './MemberList';
import { TypingIndicator } from './TypingIndicator';
import { GlossaryEditor } from './GlossaryEditor';
import { ProfilePanel } from './ProfilePanel';
import { ThreadPanel } from './ThreadPanel';
import { ServerSettingsPanel } from './ServerSettingsPanel';
import { MentionsPanel } from './MentionsPanel';
import { ChannelInviteModal } from './ChannelInviteModal';
import { useMembers } from '../hooks/useMembers';
import { usePresence } from '../hooks/usePresence';
import { useReactions } from '../hooks/useReactions';

interface ChatViewProps {
  actor: ActorProfile;
  onLogout: () => void;
}

export function ChatView({ actor, onLogout }: ChatViewProps) {
  const [dmMode, setDmMode] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showCreateServer, setShowCreateServer] = useState(false);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [showNewDM, setShowNewDM] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [showGlossary, setShowGlossary] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showServerSettings, setShowServerSettings] = useState(false);
  const [showMentions, setShowMentions] = useState(false);
  const [showChannelInvite, setShowChannelInvite] = useState(false);
  const [mutedChannels, setMutedChannels] = useState<Set<string>>(new Set());
  const [threadMessageId, setThreadMessageId] = useState<string | null>(null);
  const [threadReplies, setThreadReplies] = useState<MessageWithAuthor[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);

  const { servers, selectedServer, selectServer, createServer, joinServer } = useServers();
  const { channels, selectedChannel, selectChannel, createChannel } = useChannels(
    dmMode ? null : selectedServer?.id ?? null,
  );
  const { conversations, selectedDM, selectDM, startDM } = useDMs();
  const e2e = useE2E();
  const { members, setRole, kick } = useMembers(
    dmMode ? null : selectedServer?.id ?? null,
  );
  const { unreadCounts } = useUnreadBadges();
  const { presenceStatus } = usePresence(!!actor);
  const callerRole = members.find((m) => m.id === actor.id)?.role ?? 'member';

  const activeChannelId = dmMode ? selectedDM?.id ?? null : selectedChannel?.id ?? null;

  // Derive the DM recipient ID for E2E encryption
  const recipientId = dmMode && selectedDM
    ? selectedDM.participants.find((p) => p.id !== actor.id)?.id ?? ''
    : '';

  const { messages, loading, hasMore, connected, sendMessage, loadMore, typingUsers, notifyTyping, updateMessageContent, removeMessage } = useChat(
    actor,
    activeChannelId,
    dmMode,
    dmMode && e2e.ready && recipientId ? { e2e, recipientId } : undefined,
  );

  const { messageReactions, toggleReaction } = useReactions(activeChannelId, actor.id, messages);

  const { settings, updateSettings } = useTranslationSettings();
  const { translations, isTranslating } = useTranslation(messages, settings);

  // Load muted channels
  useEffect(() => {
    api.getMutedChannels().then((muted) => {
      setMutedChannels(new Set(Object.keys(muted)));
    });
  }, []);

  const handleToggleMute = useCallback(async (channelId: string, muted: boolean) => {
    await api.setMutePreference(channelId, 'channel', muted);
    setMutedChannels((prev) => {
      const next = new Set(prev);
      if (muted) next.add(channelId);
      else next.delete(channelId);
      return next;
    });
  }, []);

  // Handle invite links (/invite/:code)
  useEffect(() => {
    const path = window.location.pathname;
    const match = path.match(/^\/invite\/(\w+)$/);
    if (match) {
      const code = match[1];
      api.joinViaInvite(code).then((res) => {
        if (res.ok) {
          alert(`Joined server: ${res.server.name}`);
          window.history.replaceState(null, '', '/');
          window.location.reload();
        }
      }).catch(() => {
        alert('Invalid or expired invite link');
        window.history.replaceState(null, '', '/');
      });
    }
  }, []);

  // Initialize preferredLanguage from actor profile
  useEffect(() => {
    if (!localStorage.getItem('babelr:translation-settings')) {
      updateSettings({ preferredLanguage: actor.preferredLanguage });
    }
  }, [actor.preferredLanguage, updateSettings]);

  const openThread = useCallback(async (messageId: string) => {
    if (!activeChannelId) return;
    setThreadMessageId(messageId);
    setThreadLoading(true);
    try {
      const res = await api.getThreadReplies(activeChannelId, messageId);
      setThreadReplies(res.messages);
    } catch {
      setThreadReplies([]);
    } finally {
      setThreadLoading(false);
    }
  }, [activeChannelId]);

  const sendThreadReply = useCallback(async (content: string) => {
    if (!activeChannelId || !threadMessageId) return;
    await api.sendThreadReply(activeChannelId, threadMessageId, content);
    // Reload thread
    const res = await api.getThreadReplies(activeChannelId, threadMessageId);
    setThreadReplies(res.messages);
  }, [activeChannelId, threadMessageId]);

  const handleEditMessage = useCallback(async (messageId: string, content: string) => {
    if (!activeChannelId) return;
    await api.editMessage(activeChannelId, messageId, content);
    updateMessageContent(messageId, content);
  }, [activeChannelId, updateMessageContent]);

  const handleDeleteMessage = useCallback(async (messageId: string) => {
    if (!activeChannelId) return;
    await api.deleteMessage(activeChannelId, messageId);
    removeMessage(messageId);
  }, [activeChannelId, removeMessage]);

  // Derive header display name
  const headerName = dmMode
    ? selectedDM
      ? selectedDM.participants
          .filter((p) => p.id !== actor.id)
          .map((p) => p.displayName ?? p.preferredUsername)
          .join(', ')
      : 'Direct Messages'
    : selectedChannel
      ? `${selectedServer?.name ?? ''} > #${selectedChannel.name}`
      : selectedServer?.name ?? '';

  return (
    <div className="app-layout">
      <ServerSidebar
        servers={servers}
        selectedServerId={selectedServer?.id ?? null}
        dmMode={dmMode}
        onSelectServer={(id) => {
          setDmMode(false);
          selectServer(id);
        }}
        onSelectDMs={() => setDmMode(true)}
        onCreateServer={() => setShowCreateServer(true)}
      />
      <ChannelSidebar
        mode={dmMode ? 'dms' : 'channels'}
        serverName={selectedServer?.name}
        channels={channels}
        selectedChannelId={selectedChannel?.id ?? null}
        conversations={conversations}
        selectedDMId={selectedDM?.id ?? null}
        actor={actor}
        unreadCounts={unreadCounts}
        onSelectChannel={selectChannel}
        onSelectDM={selectDM}
        onCreateChannel={() => setShowCreateChannel(true)}
        onNewDM={() => setShowNewDM(true)}
        onShowMembers={() => setShowMembers(true)}
        onShowGlossary={() => setShowGlossary(true)}
        onShowServerSettings={
          ['owner', 'admin'].includes(callerRole) ? () => setShowServerSettings(true) : undefined
        }
        mutedChannels={mutedChannels}
        onToggleMute={handleToggleMute}
        selectedChannelIsPrivate={!dmMode && selectedChannel?.isPrivate}
        onInviteToChannel={!dmMode && selectedChannel?.isPrivate ? () => setShowChannelInvite(true) : undefined}
      />
      <div className="chat-panel">
        <ChannelHeader
          channelName={headerName}
          actor={actor}
          connected={connected}
          encrypted={dmMode && e2e.ready}
          onLogout={onLogout}
          onOpenSettings={() => setShowSettings(true)}
          onOpenProfile={() => setShowProfile(true)}
          onOpenMentions={() => setShowMentions(true)}
        />
        <MessageList
          messages={messages}
          loading={loading}
          hasMore={hasMore}
          onLoadMore={loadMore}
          translations={translations}
          isTranslating={isTranslating}
          actor={actor}
          messageReactions={messageReactions}
          onToggleReaction={toggleReaction}
          onOpenThread={openThread}
          onEditMessage={handleEditMessage}
          onDeleteMessage={handleDeleteMessage}
          callerRole={callerRole}
        />
        <TypingIndicator users={typingUsers} />
        {dmMode && selectedDM && (() => {
          const other = selectedDM.participants.find((p) => p.id !== actor.id);
          const lastReadAt = other?.uri ? selectedDM.readBy?.[other.uri] : undefined;
          if (!lastReadAt || !messages.length) return null;
          const latestOwn = [...messages].reverse().find((m) => m.author.id === actor.id);
          if (!latestOwn) return null;
          if (new Date(latestOwn.message.published) > new Date(lastReadAt)) return null;
          const name = other?.displayName ?? other?.preferredUsername ?? 'them';
          return <div className="dm-seen-indicator">Seen by {name}</div>;
        })()}
        <MessageInput onSend={sendMessage} disabled={!activeChannelId || !connected} onTyping={notifyTyping} />
      </div>

      {showSettings && (
        <SettingsPanel
          settings={settings}
          onUpdate={updateSettings}
          onClose={() => setShowSettings(false)}
        />
      )}
      {showCreateServer && (
        <CreateServerModal
          onCreateServer={async (name, desc) => {
            await createServer({ name, description: desc });
            setDmMode(false);
          }}
          onJoinServer={async (id) => {
            await joinServer(id);
            setDmMode(false);
          }}
          onClose={() => setShowCreateServer(false)}
        />
      )}
      {showCreateChannel && selectedServer && (
        <CreateChannelModal
          onCreateChannel={async (name, category, isPrivate) => {
            await createChannel({ name, category, isPrivate });
          }}
          onClose={() => setShowCreateChannel(false)}
        />
      )}
      {showNewDM && (
        <NewDMModal
          onStartDM={async (participantId) => {
            await startDM(participantId);
          }}
          onClose={() => setShowNewDM(false)}
        />
      )}
      {showMembers && selectedServer && (
        <MemberList
          members={members}
          actor={actor}
          callerRole={callerRole}
          presenceStatus={presenceStatus}
          onSetRole={setRole}
          onKick={kick}
          onClose={() => setShowMembers(false)}
        />
      )}
      {showGlossary && activeChannelId && (
        <GlossaryEditor
          channelId={activeChannelId}
          onClose={() => setShowGlossary(false)}
        />
      )}
      {threadMessageId && (
        <ThreadPanel
          parentMessage={messages.find((m) => m.message.id === threadMessageId)!}
          replies={threadReplies}
          loading={threadLoading}
          onSendReply={sendThreadReply}
          onClose={() => {
            setThreadMessageId(null);
            setThreadReplies([]);
          }}
        />
      )}
      {showServerSettings && selectedServer && (
        <ServerSettingsPanel
          server={selectedServer}
          onClose={() => setShowServerSettings(false)}
        />
      )}
      {showProfile && (
        <ProfilePanel
          actor={actor}
          onUpdate={() => {
            // Profile updated — reload will pick up changes via getMe()
            window.location.reload();
          }}
          onClose={() => setShowProfile(false)}
        />
      )}
      {showMentions && (
        <MentionsPanel onClose={() => setShowMentions(false)} />
      )}
      {showChannelInvite && activeChannelId && (
        <ChannelInviteModal
          channelId={activeChannelId}
          onClose={() => setShowChannelInvite(false)}
        />
      )}
    </div>
  );
}
