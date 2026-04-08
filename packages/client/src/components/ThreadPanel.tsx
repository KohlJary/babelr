// SPDX-License-Identifier: Hippocratic-3.0
import type { MessageWithAuthor } from '@babelr/shared';
import { MessageItem } from './MessageItem';
import { MessageInput } from './MessageInput';

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
  return (
    <div className="thread-panel-overlay" onClick={onClose}>
      <div className="thread-panel" onClick={(e) => e.stopPropagation()}>
        <div className="thread-header">
          <h3>Thread</h3>
          <button className="thread-close" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="thread-content">
          <div className="parent-message">
            <MessageItem
              data={parentMessage}
              compact={false}
            />
          </div>

          <div className="thread-divider" />

          {loading && <div className="thread-loading">Loading replies...</div>}

          {!loading && replies.length === 0 && (
            <div className="thread-empty">No replies yet</div>
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
    </div>
  );
}
