// SPDX-License-Identifier: Hippocratic-3.0
import type { ActorProfile } from '@babelr/shared';
import { useChat } from '../hooks/useChat';
import { ChannelHeader } from './ChannelHeader';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';

interface ChatViewProps {
  actor: ActorProfile;
  onLogout: () => void;
}

export function ChatView({ actor, onLogout }: ChatViewProps) {
  const { channel, messages, loading, hasMore, connected, sendMessage, loadMore } = useChat(actor);

  return (
    <div className="chat-view">
      <ChannelHeader channel={channel} actor={actor} connected={connected} onLogout={onLogout} />
      <MessageList
        messages={messages}
        loading={loading}
        hasMore={hasMore}
        onLoadMore={loadMore}
      />
      <MessageInput onSend={sendMessage} disabled={!channel || !connected} />
    </div>
  );
}
