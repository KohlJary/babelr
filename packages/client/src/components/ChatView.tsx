// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect } from 'react';
import type { ActorProfile } from '@babelr/shared';
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
  const { messageReactions, toggleReaction } = useReactions(
    dmMode ? null : selectedChannel?.id ?? null,
  );
  const callerRole = members.find((m) => m.id === actor.id)?.role ?? 'member';

  const activeChannelId = dmMode ? selectedDM?.id ?? null : selectedChannel?.id ?? null;

  // Derive the DM recipient ID for E2E encryption
  const recipientId = dmMode && selectedDM
    ? selectedDM.participants.find((p) => p.id !== actor.id)?.id ?? ''
    : '';

  const { messages, loading, hasMore, connected, sendMessage, loadMore, typingUsers, notifyTyping } = useChat(
    actor,
    activeChannelId,
    dmMode,
    dmMode && e2e.ready && recipientId ? { e2e, recipientId } : undefined,
  );

  const { settings, updateSettings } = useTranslationSettings();
  const { translations, isTranslating } = useTranslation(messages, settings);

  // Initialize preferredLanguage from actor profile
  useEffect(() => {
    if (!localStorage.getItem('babelr:translation-settings')) {
      updateSettings({ preferredLanguage: actor.preferredLanguage });
    }
  }, [actor.preferredLanguage, updateSettings]);

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
      />
      <div className="chat-panel">
        <ChannelHeader
          channelName={headerName}
          actor={actor}
          connected={connected}
          encrypted={dmMode && e2e.ready}
          onLogout={onLogout}
          onOpenSettings={() => setShowSettings(true)}
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
        />
        <TypingIndicator users={typingUsers} />
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
          onCreateChannel={async (name) => {
            await createChannel({ name });
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
    </div>
  );
}
