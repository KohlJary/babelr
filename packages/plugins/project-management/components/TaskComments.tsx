// SPDX-License-Identifier: Hippocratic-3.0
import { useChat } from '../../../client/src/hooks/useChat.js';
import { useTranslation } from '../../../client/src/hooks/useTranslation.js';
import { useTranslationSettings } from '../../../client/src/hooks/useTranslationSettings.js';
import { MessageList } from '../../../client/src/components/MessageList.js';
import { MessageInput } from '../../../client/src/components/MessageInput.js';
import type { ActorProfile } from '@babelr/shared';

/**
 * Embedded comment thread for a work item. Each item's chat_id points
 * at an OrderedCollection (created server-side at item-create time),
 * which makes the existing useChat / MessageList / MessageInput stack
 * work out-of-the-box — translation, reactions, and threading all
 * come for free via the core chat pipeline.
 */
export function TaskComments({
  actor,
  chatId,
}: {
  actor: ActorProfile;
  chatId: string;
}) {
  const {
    messages,
    loading,
    hasMore,
    sendMessage,
    loadMore,
    typingUsers: _typingUsers,
    notifyTyping,
  } = useChat(actor, chatId, false);
  void _typingUsers;
  const { settings } = useTranslationSettings();
  const { translations, isTranslating } = useTranslation(messages, settings);
  return (
    <div className="pm-comments">
      <MessageList
        messages={messages}
        loading={loading}
        hasMore={hasMore}
        onLoadMore={loadMore}
        translations={translations}
        isTranslating={isTranslating}
        actor={actor}
      />
      <MessageInput
        onSend={sendMessage}
        disabled={loading}
        onTyping={notifyTyping}
      />
    </div>
  );
}
