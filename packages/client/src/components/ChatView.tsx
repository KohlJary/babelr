// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect, useCallback, useRef, createElement } from 'react';
import type { ActorProfile, MessageWithAuthor, WsServerMessage } from '@babelr/shared';
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
import { PluginSidebarSlots } from '../plugins/PluginSidebarSlots';
import type { SidebarSlotHostContext } from '../plugins/sidebar-registry';
import { ChannelHeader } from './ChannelHeader';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { CreateServerModal } from './CreateServerModal';
import { CreateChannelModal } from './CreateChannelModal';
import { NewDMModal } from './NewDMModal';
import { MemberList } from './MemberList';
import { TypingIndicator } from './TypingIndicator';
import { GlossaryEditor } from './GlossaryEditor';
import { ThreadPanel } from './ThreadPanel';
import { ChannelInviteModal } from './ChannelInviteModal';
import { VoicePanel } from './VoicePanel';
import { CallView } from './CallView';
import { EmbedSidebar, type EmbedSidebarTarget } from './EmbedSidebar';
import { EmbedHostProvider } from './E';
import { SidePanel } from './SidePanel';
import { useT } from '../i18n/I18nProvider';
import { VerificationBanner } from './VerificationBanner';
import { subscribeToPush } from '../push';
import type { EmbedNavCtx } from '../embeds/registry';
import type { WikiRefKind } from '@babelr/shared';
import { getView, listViews, type ViewHostContext, type ViewState } from '../views/registry';
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
  const t = useT();

  useEffect(() => {
    void subscribeToPush();
  }, []);


  const [dmMode, setDmMode] = useState(false);
  const [showCreateServer, setShowCreateServer] = useState(false);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [showNewDM, setShowNewDM] = useState(false);
  const [showGlossary, setShowGlossary] = useState(false);
  const [showPins, setShowPins] = useState(false);
  const [showChannelInvite, setShowChannelInvite] = useState(false);
  const [highlightMessageId, setHighlightMessageId] = useState<string | null>(null);
  // Which primary view fills the chat panel area. 'chat' is the
  // default — messages + input. 'calendar' and 'wiki' replace the
  // chat with the respective content surface, matching how Discord
  // renders its Events and Server Discovery tabs as primary
  // content rather than modal overlays. Channel selection or DM
  // selection implicitly resets this to 'chat'.
  // Main-panel view routing. Null = the chat default (channel header +
  // message list + input). Otherwise the host dispatches to whichever
  // view is registered with this id; per-view scratch state goes in
  // `viewState` (free-form so plugin authors can store anything).
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [viewState, setViewState] = useState<ViewState>({});
  const openView = (id: string, state: ViewState = {}) => {
    setActiveViewId(id);
    setViewState(state);
  };
  const closeView = () => {
    setActiveViewId(null);
    setViewState({});
  };
  const voice = useVoice(actor.id);
  const [mutedChannels, setMutedChannels] = useState<Set<string>>(new Set());
  const [embedSidebar, setEmbedSidebar] = useState<EmbedSidebarTarget | null>(null);
  const openEmbedPreview = (kind: WikiRefKind, slug: string, serverSlug?: string) => {
    setEmbedSidebar({ kind, slug, serverSlug });
  };
  const navCtx: EmbedNavCtx = {
    selectChannel: (id) => {
      setDmMode(false);
      selectChannel(id);
      closeView();
    },
    openView,
    closeView,
  };
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

  // Pinned messages
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const [pinnedData, setPinnedData] = useState<MessageWithAuthor[]>([]);
  const reloadPins = useCallback(() => {
    if (!activeChannelId) { setPinnedIds(new Set()); setPinnedData([]); return; }
    api.getPins(activeChannelId).then((res) => {
      const pinItems = res.pins as Array<{ pin: unknown; message: import('@babelr/shared').MessageView; author: import('@babelr/shared').AuthorView }>;
      setPinnedIds(new Set(pinItems.map((p) => p.message.id)));
      setPinnedData(pinItems.map((p) => ({ message: p.message, author: p.author })));
    }).catch(() => {});
  }, [activeChannelId]);
  useEffect(() => { reloadPins(); }, [reloadPins]);
  // Real-time pin sync via WS
  useEffect(() => {
    if (!activeChannelId) return;
    const handler = (e: Event) => {
      const msg = (e as CustomEvent).detail as { type: string; payload: { channelId: string } };
      if ((msg.type === 'pin:add' || msg.type === 'pin:remove') && msg.payload.channelId === activeChannelId) {
        reloadPins();
      }
    };
    window.addEventListener('babelr:ws', handler);
    return () => window.removeEventListener('babelr:ws', handler);
  }, [activeChannelId, reloadPins]);

  const handlePin = useCallback(async (messageId: string) => {
    if (!activeChannelId) return;
    await api.pinMessage(activeChannelId, messageId);
    setPinnedIds((prev) => new Set([...prev, messageId]));
  }, [activeChannelId]);
  const jumpToMessage = useCallback((messageId: string) => {
    setShowPins(false);
    setHighlightMessageId(messageId);
    // Clear highlight after animation
    setTimeout(() => setHighlightMessageId(null), 2500);
  }, []);

  const handleUnpin = useCallback(async (messageId: string) => {
    if (!activeChannelId) return;
    await api.unpinMessage(activeChannelId, messageId);
    setPinnedIds((prev) => { const next = new Set(prev); next.delete(messageId); return next; });
  }, [activeChannelId]);

  // Close the embed sidebar whenever the user switches channels or
  // servers — embed previews are contextual to where the user is.
  useEffect(() => {
    setEmbedSidebar(null);
  }, [selectedChannel?.id, selectedServer?.id, dmMode]);

  // Derive the DM recipient ID for E2E encryption
  const recipientId = dmMode && selectedDM
    ? selectedDM.participants.find((p) => p.id !== actor.id)?.id ?? ''
    : '';

  // Ref-based forwarder so useChat can pipe WS events to useReactions
  // without a dependency cycle (useReactions needs messages from useChat).
  const extraWsRef = useRef<(msg: WsServerMessage) => void>(() => {});
  const stableExtraWs = useCallback((msg: WsServerMessage) => extraWsRef.current(msg), []);

  const { messages, loading, hasMore, connected, sendMessage, loadMore, typingUsers, notifyTyping, updateMessageContent, removeMessage } = useChat(
    actor,
    activeChannelId,
    dmMode,
    dmMode && e2e.ready && recipientId ? { e2e, recipientId } : undefined,
    stableExtraWs,
    {
      channelName: dmMode ? undefined : selectedChannel?.name,
      serverName: dmMode ? undefined : selectedServer?.name,
    },
  );

  const { messageReactions, handleWsMessage: handleReactionWs, toggleReaction } = useReactions(activeChannelId, actor.id, messages);
  extraWsRef.current = handleReactionWs;

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
  // opens the embed sidebar with a wiki page preview. Only active when
  // a server is selected — wiki pages are server-scoped.
  useEffect(() => {
    if (!selectedServer || dmMode) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.('a[href^="#wiki/"]') as HTMLAnchorElement | null;
      if (!anchor) return;
      e.preventDefault();
      const slug = decodeURIComponent(anchor.getAttribute('href')!.slice('#wiki/'.length));
      setEmbedSidebar({ kind: 'page', slug });
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [selectedServer, dmMode]);

  return (
    <EmbedHostProvider host={{ actor, onPreviewEmbed: openEmbedPreview }}>
    {!actor.emailVerified && <VerificationBanner />}
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
        onOpenManual={() => openView('manual')}
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
          closeView();
        }}
        onSelectDM={(id) => {
          selectDM(id);
          closeView();
        }}
        onCreateChannel={() => setShowCreateChannel(true)}
        onNewDM={() => setShowNewDM(true)}
        onShowMembers={() => {}}
        onShowGlossary={() => setShowGlossary(true)}
        onShowServerSettings={
          ['owner', 'admin'].includes(callerRole) ? () => openView('server-settings') : undefined
        }
        mutedChannels={mutedChannels}
        onToggleMute={handleToggleMute}
        selectedChannelIsPrivate={!dmMode && selectedChannel?.isPrivate}
        onInviteToChannel={!dmMode && selectedChannel?.isPrivate ? () => setShowChannelInvite(true) : undefined}
        onShowFriends={dmMode ? () => openView('friends') : undefined}
        canManageChannels={!dmMode && ['owner', 'admin', 'moderator'].includes(callerRole)}
        onEditChannel={(channelId) => openView('channel-settings', { channelId })}
        onLeaveServer={
          !dmMode && selectedServer && callerRole !== 'owner'
            ? () => void leaveServer(selectedServer.id)
            : undefined
        }
        viewEntries={listViews()
          .filter((v) => {
            if (!v.isAvailable) return false;
            const hostCheck: ViewHostContext = {
              actor,
              selectedServer: selectedServer ? { id: selectedServer.id, name: selectedServer.name } : null,
              callerRole,
              channels,
              navCtx,
              openEmbedPreview,
              closeView,
              onActorUpdate,
            };
            return v.isAvailable(hostCheck);
          })
          .map((v) => ({ id: v.id, label: v.label, icon: v.icon }))}
        onOpenView={openView}
        onJoinVoice={(channelId) => {
          if (voice.state.channelId === channelId) return;
          if (voice.state.channelId) voice.leave();
          const ch = channels.find((c) => c.id === channelId);
          void voice.join(channelId, ch?.uri);
        }}
        activeVoiceChannelId={voice.state.channelId}
        pluginSlots={(() => {
          const sidebarHost: SidebarSlotHostContext = {
            actor,
            selectedServerId: selectedServer?.id ?? null,
            selectedServerName: selectedServer?.name ?? null,
            channels,
            routeBase: '/api',
            openView,
          };
          return <PluginSidebarSlots host={sidebarHost} />;
        })()}
      />
      <div className="chat-panel">
        {(() => {
          if (!activeViewId) return null;
          const def = getView(activeViewId);
          if (!def) return null;
          const hostCtx: ViewHostContext = {
            actor,
            selectedServer: selectedServer
              ? { id: selectedServer.id, name: selectedServer.name }
              : null,
            callerRole,
            channels,
            navCtx,
            openEmbedPreview,
            closeView,
            onActorUpdate,
          };
          return createElement(def.View, { host: hostCtx, viewState });
        })()}
        {!activeViewId && (
          <>
        <ChannelHeader
          channelName={headerName}
          channelTopic={dmMode ? undefined : selectedChannel?.topic}
          actor={actor}
          connected={connected}
          encrypted={dmMode && e2e.ready}
          onLogout={onLogout}
          onOpenSettings={() => openView('settings')}
          onOpenProfile={() => openView('settings')}
          onOpenMentions={() => openView('mentions')}
          onOpenPins={activeChannelId ? () => setShowPins((v) => !v) : undefined}
          pinCount={pinnedIds.size || undefined}
        />
        {voice.state.channelId &&
        selectedChannel?.id === voice.state.channelId &&
        selectedChannel?.channelType === 'voice' ? (
          <CallView
            channelName={headerName}
            actor={actor}
            voice={voice.state}
            chatId={selectedChannel.id}
            translationSettings={settings}
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
        ) : (
          <>
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
                  openView('wiki', { draft: { title, content } });
                }
              : undefined
          }
          onPreviewEmbed={openEmbedPreview}
          callerRole={callerRole}
          pinnedMessageIds={pinnedIds}
          onPinMessage={(id) => void handlePin(id)}
          onUnpinMessage={(id) => void handleUnpin(id)}
          highlightMessageId={highlightMessageId}
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
          </>
        )}
      </div>

      {/* === Unified right panel === */}
      {embedSidebar ? (
        <EmbedSidebar
          target={embedSidebar}
          actor={actor}
          serverId={selectedServer?.id ?? null}
          navCtx={navCtx}
          onClose={() => setEmbedSidebar(null)}
        />
      ) : threadMessageId ? (
        <SidePanel
          title={t('thread.title')}
          onClose={() => {
            setThreadMessageId(null);
            setThreadReplies([]);
          }}
          wide
        >
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
        </SidePanel>
      ) : showGlossary && activeChannelId ? (
        <SidePanel
          title={t('glossary.title')}
          onClose={() => setShowGlossary(false)}
        >
          <GlossaryEditor
            channelId={activeChannelId}
            onClose={() => setShowGlossary(false)}
          />
        </SidePanel>
      ) : showPins && activeChannelId ? (
        <SidePanel
          title={t('pins.title')}
          onClose={() => setShowPins(false)}
        >
          <div className="pinned-list">
            {pinnedData.length === 0 && (
              <div className="scroll-list-empty">{t('pins.empty')}</div>
            )}
            {pinnedData.map((item) => {
              const authorName = item.author.displayName ?? item.author.preferredUsername;
              const snippet = item.message.content.length > 200
                ? item.message.content.slice(0, 200) + '…'
                : item.message.content;
              const chName = !dmMode ? selectedChannel?.name : undefined;
              const srvName = !dmMode ? selectedServer?.name : undefined;
              return (
                <div key={item.message.id} className="pinned-item">
                  <div
                    className="message-embed ok pinned-embed"
                    role="button"
                    tabIndex={0}
                    onClick={() => jumpToMessage(item.message.id)}
                    style={{ cursor: 'pointer' }}
                  >
                    <span className="message-embed-icon">💬</span>
                    <span className="message-embed-body">
                      <span className="message-embed-meta">
                        <strong>{authorName}</strong>
                        {chName && <> · #{chName}</>}
                        {srvName && <> · <span className="message-embed-server">{srvName}</span></>}
                      </span>
                      <span className="message-embed-snippet">{snippet}</span>
                    </span>
                  </div>
                  <button
                    className="pinned-unpin-btn"
                    onClick={() => void handleUnpin(item.message.id)}
                    title={t('pins.unpin')}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        </SidePanel>
      ) : selectedServer && !dmMode && !activeViewId ? (
        <SidePanel
          title={t('members.title')}
          onClose={() => {}}
        >
          <MemberList
            serverId={selectedServer.id}
            members={members}
            actor={actor}
            callerRole={callerRole}
            presenceStatus={presenceStatus}
            onKick={kick}
            onClose={() => {}}
            onRolesChanged={reloadMembers}
          />
        </SidePanel>
      ) : null}

      {/* Settings now renders as a registered view — see
         register-builtin.ts SettingsView. */}
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
      {/* MemberList, GlossaryEditor, and ThreadPanel now render in the
         unified right panel above (SidePanel wrappers). */}
      {/* Server settings now renders as a registered view. */}
      {/* Profile now renders as the Profile tab within the settings view. */}
      {/* Mentions now renders as a registered view. */}
      {showChannelInvite && activeChannelId && (
        <ChannelInviteModal
          channelId={activeChannelId}
          serverId={selectedServer?.id}
          onClose={() => setShowChannelInvite(false)}
        />
      )}
      {/* Friends now renders as a registered view. */}
      {/* Audit log now renders as a tab in the server-settings view. */}
      {/* Channel settings now renders as a registered view. */}
      {voice.state.channelId &&
        // Hide the floating widget when the user is already viewing the
        // full-size CallView for this same channel.
        !(
          activeViewId === null &&
          selectedChannel?.id === voice.state.channelId &&
          selectedChannel?.channelType === 'voice'
        ) &&
        (() => {
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
    </EmbedHostProvider>
  );
}
