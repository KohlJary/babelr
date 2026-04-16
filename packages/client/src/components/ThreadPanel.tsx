// SPDX-License-Identifier: Hippocratic-3.0
import type { MessageWithAuthor } from '@babelr/shared';
import { MessageItem } from './MessageItem';
import { MessageInput } from './MessageInput';
import { useT } from '../i18n/I18nProvider';

interface ThreadPanelProps {
  parentMessage: MessageWithAuthor;
  replies: MessageWithAuthor[];
  loading: boolean;
  onSendReply: (content: string) => Promise<void>;
  onClose: () => void;
}

export function ThreadPanel({
  parentMessage,
  replies,
  loading,
  onSendReply,
  onClose,
}: ThreadPanelProps) {
  const t = useT();
  return (
    <div className="thread-panel-body">
      <div className="thread-content">
        <div className="parent-message">
          <MessageItem
            data={parentMessage}
            compact={false}
          />
        </div>

        <div className="thread-divider" />

        {loading && <div className="thread-loading">{t('thread.loadingReplies')}</div>}

        {!loading && replies.length === 0 && (
          <div className="thread-empty">{t('thread.empty')}</div>
        )}

        <div className="thread-replies">
          {replies.map((item) => (
            <MessageItem
              key={item.message.id}
              data={item}
              compact={false}
            />
          ))}
        </div>
      </div>

      <div className="thread-input-wrapper">
        <MessageInput onSend={onSendReply} disabled={false} />
      </div>
    </div>
  );
}
