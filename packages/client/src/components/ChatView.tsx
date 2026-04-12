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
import { FriendsPanel } from './FriendsPanel';
import { ChannelSettingsPanel } from './ChannelSettingsPanel';
import { EventsPanel } from './EventsPanel';
import { WikiPanel } from './WikiPanel';
import { VoicePanel } from './VoicePanel';
import { useVoice } from '../hooks/useVoice';
import { useMembers } from '../hooks/useMembers';
import { usePresence } from '../hooks/usePresence';
import { useReactions } from '../hooks/useReactions';

interface ChatViewProps {
  actor: ActorProfile;
  onLogout: () => void;
  onActorUpdate?: (actor: ActorProfile) => void;
}

export function ChatView({ actor, onLogout, onActorUpdate }: ChatViewProps) {
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
  const [showFriends, setShowFriends] = useState(false);
  const [editingChannelId, setEditingChannelId] = useState<string | null>(null);
  // Which primary view fills the chat panel area. 'chat' is the
  // default — messages + input. 'calendar' and 'wiki' replace the
  // chat with the respective content surface, matching how Discord
  // renders its Events and Server Discovery tabs as primary
  // content rather than modal overlays. Channel selection or DM
  // selection implicitly resets this to 'chat'.
  const [mainView, setMainView] = useState<'chat' | 'calendar' | 'wiki'>('chat');
  const [wikiInitialSlug, setWikiInitialSlug] = useState<string | null>(null);
  const [wikiInitialDraft, setWikiInitialDraft] = useState<{ title?: string; content?: string } | null>(null);
  // When the user clicks an `[[event:slug]]` embed we need to switch
  // to the calendar view and auto-open the detail panel for that
  // event. Tracked here so ChatView can pass the id into EventsPanel
  // after mainView flips to 'calendar'.
  const [calendarInitialEventId, setCalendarInitialEventId] = useState<string | null>(null);
  const voice = useVoice(actor.id);
  const [mutedChannels, setMutedChannels] = useState<Set<string>>(new Set());
  const [threadMessageId, setThreadMessageId] = useState<string | null>(null);
  const [threadReplies, setThreadReplies] = useState<MessageWithAuthor[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);

  const { servers, selectedServer, selectServer, createServer, joinServer, leaveServer, updateServer, refreshServers } = useServers();
  const { channels, selectedChannel, selectChannel, createChannel, updateChannel } = useChannels(
    dmMode ? null : selectedServer?.id ?? null,
  );
  const { conversations, selectedDM, selectDM, startDM } = useDMs();
  const e2e = useE2E();
  const { members, reload: reloadMembers, kick } = useMembers(
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

  // Intercept clicks on in-app wiki refs rendered as `<a href="#wiki/slug">`
  // so the browser doesn't try to navigate to a fragment, and instead
  // opens the WikiPanel at the referenced page. Only active when a
  // server is selected — wiki pages are server-scoped.
  useEffect(() => {
    if (!selectedServer || dmMode) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.('a[href^="#wiki/"]') as HTMLAnchorElement | null;
      if (!anchor) return;
      e.preventDefault();
      const slug = decodeURIComponent(anchor.getAttribute('href')!.slice('#wiki/'.length));
      setWikiInitialDraft(null);
      setWikiInitialSlug(slug);
      setMainView('wiki');
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [selectedServer, dmMode]);

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
        serverTagline={selectedServer?.tagline}
        channels={channels}
        selectedChannelId={selectedChannel?.id ?? null}
        conversations={conversations}
        selectedDMId={selectedDM?.id ?? null}
        actor={actor}
        unreadCounts={unreadCounts}
        onSelectChannel={(id) => {
          selectChannel(id);
          setMainView('chat');
        }}
        onSelectDM={(id) => {
          selectDM(id);
          setMainView('chat');
        }}
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
        onShowFriends={dmMode ? () => setShowFriends(true) : undefined}
        canManageChannels={!dmMode && ['owner', 'admin', 'moderator'].includes(callerRole)}
        onEditChannel={(channelId) => setEditingChannelId(channelId)}
        onLeaveServer={
          !dmMode && selectedServer && callerRole !== 'owner'
            ? () => void leaveServer(selectedServer.id)
            : undefined
        }
        onShowCalendar={() => setMainView('calendar')}
        onShowWiki={!dmMode && selectedServer ? () => setMainView('wiki') : undefined}
        onJoinVoice={(channelId) => {
          if (voice.state.channelId === channelId) return;
          if (voice.state.channelId) voice.leave();
          void voice.join(channelId);
        }}
        activeVoiceChannelId={voice.state.channelId}
      />
      <div className="chat-panel">
        {mainView === 'calendar' && (
          <EventsPanel
            scope={dmMode || !selectedServer ? 'user' : 'server'}
            ownerId={dmMode || !selectedServer ? actor.id : selectedServer.id}
            ownerName={dmMode || !selectedServer ? undefined : selectedServer.name}
            actor={actor}
            channels={!dmMode ? channels : undefined}
            canCreate={
              dmMode || !selectedServer
                ? true
                : ['owner', 'admin', 'moderator'].includes(callerRole)
            }
            initialEventId={calendarInitialEventId}
            onClose={() => {
              setMainView('chat');
              setCalendarInitialEventId(null);
            }}
            onGoToChannel={(channelId) => {
              setDmMode(false);
              selectChannel(channelId);
              setMainView('chat');
              setCalendarInitialEventId(null);
            }}
          />
        )}
        {mainView === 'wiki' && selectedServer && (
          <WikiPanel
            serverId={selectedServer.id}
            serverName={selectedServer.name}
            callerRole={callerRole}
            initialSlug={wikiInitialSlug}
            initialDraft={wikiInitialDraft}
            onNavigateMessageEmbed={(embed) => {
              if (embed.channelId) {
                setDmMode(false);
                selectChannel(embed.channelId);
                setMainView('chat');
              }
            }}
            onNavigateEventEmbed={(embed) => {
              setCalendarInitialEventId(embed.id);
              setMainView('calendar');
            }}
            onClose={() => {
              setMainView('chat');
              setWikiInitialSlug(null);
              setWikiInitialDraft(null);
            }}
          />
        )}
        {mainView === 'chat' && (
          <>
        <ChannelHeader
          channelName={headerName}
          channelTopic={dmMode ? undefined : selectedChannel?.topic}
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
          onConvertToWikiPage={
            !dmMode && selectedServer
              ? (item) => {
                  // Use the first line as the proposed title, rest as content
                  const content = item.message.content;
                  const firstBreak = content.indexOf('\n');
                  const title =
                    firstBreak === -1 ? content.slice(0, 120) : content.slice(0, firstBreak).slice(0, 120);
                  setWikiInitialSlug(null);
                  setWikiInitialDraft({ title, content });
                  setMainView('wiki');
                }
              : undefined
          }
          onNavigateMessageEmbed={(embed) => {
            // Clicking a message embed navigates to the source.
            // Scrolling to the specific message is a follow-up — for
            // now we just switch to the channel containing it.
            if (embed.channelId) {
              setDmMode(false);
              selectChannel(embed.channelId);
            }
          }}
          onNavigateEventEmbed={(embed) => {
            setCalendarInitialEventId(embed.id);
            setMainView('calendar');
          }}
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
          </>
        )}
      </div>

      {showSettings && (
        <SettingsPanel
          settings={settings}
          onUpdate={updateSettings}
          onClose={() => setShowSettings(false)}
          onActorUpdate={onActorUpdate}
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
          onJoinedRemote={() => {
            void refreshServers();
            setDmMode(false);
          }}
          onClose={() => setShowCreateServer(false)}
        />
      )}
      {showCreateChannel && selectedServer && (
        <CreateChannelModal
          onCreateChannel={async (name, category, isPrivate, channelType) => {
            await createChannel({ name, category, isPrivate, channelType });
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
          serverId={selectedServer.id}
          members={members}
          actor={actor}
          callerRole={callerRole}
          presenceStatus={presenceStatus}
          onKick={kick}
          onClose={() => setShowMembers(false)}
          onRolesChanged={reloadMembers}
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
          onUpdated={updateServer}
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
          serverId={selectedServer?.id}
          onClose={() => setShowChannelInvite(false)}
        />
      )}
      {showFriends && (
        <FriendsPanel
          onStartDM={async (actorId) => {
            setDmMode(true);
            await startDM(actorId);
          }}
          onClose={() => setShowFriends(false)}
        />
      )}
      {editingChannelId && (() => {
        const ch = channels.find((c) => c.id === editingChannelId);
        if (!ch) return null;
        return (
          <ChannelSettingsPanel
            channel={ch}
            onClose={() => setEditingChannelId(null)}
            onUpdated={updateChannel}
          />
        );
      })()}
      {voice.state.channelId && (() => {
        const vCh = channels.find((c) => c.id === voice.state.channelId);
        return (
          <VoicePanel
            channelName={vCh?.name ?? 'voice'}
            actor={actor}
            voice={voice.state}
            onLeave={voice.leave}
            onToggleMute={voice.toggleMute}
            onToggleDeafen={voice.toggleDeafen}
            onTogglePushToTalk={voice.togglePushToTalk}
            onToggleVideo={voice.toggleVideo}
            onToggleScreenShare={voice.toggleScreenShare}
            onPeerVolume={voice.setPeerVolume}
            getLocalVideoStream={voice.getLocalVideoStream}
            getPeerVideoStream={voice.getPeerVideoStream}
            getLocalScreenStream={voice.getLocalScreenStream}
            getPeerScreenStream={voice.getPeerScreenStream}
          />
        );
      })()}
    </div>
  );
}
