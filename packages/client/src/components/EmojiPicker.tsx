// SPDX-License-Identifier: Hippocratic-3.0
import { useEffect, useRef } from 'react';

const COMMON_EMOJIS = ['👍', '❤️', '😂', '🔥', '👀', '😍', '🎉', '😢', '🤔', '✨', '👏', '🚀'];

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
  onClose: () => void;
  anchorRect?: DOMRect;
}

export function EmojiPicker({ onSelect, onClose, anchorRect }: EmojiPickerProps) {
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (pickerRef.current && anchorRect) {
      pickerRef.current.style.left = `${anchorRect.left}px`;
      pickerRef.current.style.top = `${anchorRect.top - pickerRef.current.offsetHeight - 8}px`;
    }
  }, [anchorRect]);

  return (
    <>
      <div className="emoji-picker-overlay" onClick={onClose} />
      <div className="emoji-picker" ref={pickerRef}>
        {COMMON_EMOJIS.map((emoji) => (
          <button
            key={emoji}
            className="emoji-btn"
            onClick={() => {
              onSelect(emoji);
              onClose();
            }}
          >
            {emoji}
          </button>
        ))}
      </div>
    </>
  );
}
