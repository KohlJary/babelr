// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useRef } from 'react';

interface MessageInputProps {
  onSend: (content: string) => Promise<void>;
  disabled: boolean;
  onTyping?: () => void;
}

export function MessageInput({ onSend, disabled, onTyping }: MessageInputProps) {
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = async () => {
    const content = value.trim();
    if (!content || sending) return;

    setSending(true);
    try {
      await onSend(content);
      setValue('');
      inputRef.current?.focus();
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="message-input">
      <textarea
        ref={inputRef}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          if (e.target.value.length > 0) onTyping?.();
        }}
        onKeyDown={handleKeyDown}
        placeholder="Send a message..."
        disabled={disabled || sending}
        rows={1}
      />
      <button onClick={handleSubmit} disabled={disabled || sending || !value.trim()}>
        Send
      </button>
    </div>
  );
}
