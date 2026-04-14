// SPDX-License-Identifier: Hippocratic-3.0
import { useMemo } from 'react';
import type { ActorProfile } from '@babelr/shared';
import type { UseVoiceState } from '../hooks/useVoice';
import { useChat } from '../hooks/useChat';
import { useTranslation } from '../hooks/useTranslation';
import type { TranslationSettings } from '../translation';
import { useVoiceStreams } from '../hooks/useVoiceStreams';
import { useT } from '../i18n/I18nProvider';
import { VoiceTile } from './VoiceTile';
import { VoiceControls } from './VoiceControls';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { TypingIndicator } from './TypingIndicator';
import { RightSidebar } from './RightSidebar';

interface CallViewProps {
  /** Display name for the empty state / status. ChannelHeader renders
   *  separately above this view, so we don't repeat the title here. */
  channelName: string;
  actor: ActorProfile;
  voice: UseVoiceState;
  /** Source for the right-sidebar text chat. For a voice channel, this
   *  is the channel id itself (channels accept text alongside voice).
   *  For DM/event call reuse, pass the dm/event chat id. */
  chatId: string | null;
  translationSettings: TranslationSettings;
  onLeave: () => void;
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onTogglePushToTalk: () => void;
  onToggleVideo: () => void | Promise<void>;
  onToggleScreenShare: () => void | Promise<void>;
  onPeerVolume: (actorId: string, volume: number) => void;
  getLocalVideoStream: () => MediaStream | null;
  getPeerVideoStream: (actorId: string) => MediaStream | null;
  getLocalScreenStream: () => MediaStream | null;
  getPeerScreenStream: (actorId: string) => MediaStream | null;
}

/**
 * Full-size call surface, shown in place of the message list when the
 * user is in a call AND has the corresponding voice channel selected.
 *
 * Layout:
 * - Stage (left): participant grid OR screen-share pane + tile strip
 * - Controls bar at the bottom of the stage
 * - Right sidebar with the channel's text chat (default + only tab
 *   for now; future: participants tab, settings tab, etc.)
 *
 * `chatId` is the only chat-source dependency, so DM / event calls
 * can later reuse this surface by passing dmChatId / eventChatId.
 */
export function CallView({
  channelName,
  actor,
  voice,
  chatId,
  translationSettings,
  onLeave,
  onToggleMute,
  onToggleDeafen,
  onTogglePushToTalk,
  onToggleVideo,
  onToggleScreenShare,
  onPeerVolume,
  getLocalVideoStream,
  getPeerVideoStream,
  getLocalScreenStream,
  getPeerScreenStream,
}: CallViewProps) {
  const t = useT();
  const { localVideoStream, localScreenStream, peerVideoStreams, peerScreenStreams } =
    useVoiceStreams(voice, {
      getLocalVideoStream,
      getLocalScreenStream,
      getPeerVideoStream,
      getPeerScreenStream,
    });

  const {
    messages: chatMessages,
    loading: chatLoading,
    hasMore: chatHasMore,
    connected: chatConnected,
    sendMessage: chatSend,
    loadMore: chatLoadMore,
    typingUsers: chatTyping,
    notifyTyping: chatNotifyTyping,
  } = useChat(actor, chatId, false);
  const { translations: chatTranslations, isTranslating: chatIsTranslating } =
    useTranslation(chatMessages, translationSettings);

  const selfActor = useMemo(
    () => ({
      id: actor.id,
      preferredUsername: actor.preferredUsername,
      displayName: actor.displayName,
      avatarUrl: actor.avatarUrl ?? null,
    }),
    [actor.id, actor.preferredUsername, actor.displayName, actor.avatarUrl],
  );

  // Anyone (self or peers) currently sharing a screen drives the
  // "presentation mode" layout: big screen pane on top, participant
  // strip below. Multiple simultaneous shares stack vertically.
  const peerScreens = voice.peers.filter((p) => p.hasScreen);
  const screenSharing = !!localScreenStream || peerScreens.length > 0;

  return (
    <div className="call-view">
      <div className="call-main">
        <div className={`call-stage ${screenSharing ? 'with-screen' : 'grid'}`}>
          {screenSharing ? (
            <>
              <div className="call-screen-pane">
                {localScreenStream && (
                  <VoiceTile
                    actor={selfActor}
                    stream={localScreenStream}
                    speaking={false}
                    isSelf
                    isScreen
                  />
                )}
                {peerScreens.map((peer) => (
                  <VoiceTile
                    key={`${peer.actorId}-screen`}
                    actor={peer.actor}
                    stream={peerScreenStreams.get(peer.actorId) ?? null}
                    speaking={false}
                    connected={peer.connected}
                    isScreen
                  />
                ))}
              </div>
              <div className="call-tile-strip">
                <VoiceTile
                  actor={selfActor}
                  stream={localVideoStream}
                  speaking={voice.localSpeaking}
                  muted={voice.micMuted}
                  isSelf
                />
                {voice.peers.map((peer) => (
                  <VoiceTile
                    key={peer.actorId}
                    actor={peer.actor}
                    stream={peerVideoStreams.get(peer.actorId) ?? null}
                    speaking={peer.speaking}
                    connected={peer.connected}
                    volume={peer.volume}
                    onVolumeChange={(v) => onPeerVolume(peer.actorId, v)}
                  />
                ))}
              </div>
            </>
          ) : (
            <div className="call-grid">
              <VoiceTile
                actor={selfActor}
                stream={localVideoStream}
                speaking={voice.localSpeaking}
                muted={voice.micMuted}
                isSelf
              />
              {voice.peers.map((peer) => (
                <VoiceTile
                  key={peer.actorId}
                  actor={peer.actor}
                  stream={peerVideoStreams.get(peer.actorId) ?? null}
                  speaking={peer.speaking}
                  connected={peer.connected}
                  volume={peer.volume}
                  onVolumeChange={(v) => onPeerVolume(peer.actorId, v)}
                />
              ))}
              {voice.peers.length === 0 && voice.status === 'connected' && (
                <div className="call-empty">
                  {t('voice.noParticipants')} — {channelName}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="call-controls-area">
          <VoiceControls
            voice={voice}
            onLeave={onLeave}
            onToggleMute={onToggleMute}
            onToggleDeafen={onToggleDeafen}
            onTogglePushToTalk={onTogglePushToTalk}
            onToggleVideo={onToggleVideo}
            onToggleScreenShare={onToggleScreenShare}
          />
          {voice.pushToTalk && <div className="voice-ptt-hint">{t('voice.pttHint')}</div>}
        </div>
      </div>

      <RightSidebar
        className="call-right-sidebar"
        tabs={[
          {
            id: 'chat',
            label: t('voice.chatTab'),
            render: () => (
              <div className="call-chat">
                {chatId ? (
                  <>
                    <MessageList
                      messages={chatMessages}
                      loading={chatLoading}
                      hasMore={chatHasMore}
                      onLoadMore={chatLoadMore}
                      translations={chatTranslations}
                      isTranslating={chatIsTranslating}
                      actor={actor}
                    />
                    <TypingIndicator users={chatTyping} />
                    <MessageInput
                      onSend={chatSend}
                      disabled={!chatConnected}
                      onTyping={chatNotifyTyping}
                    />
                  </>
                ) : (
                  <div className="call-chat-empty">
                    {t('voice.chatUnavailable')}
                  </div>
                )}
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
