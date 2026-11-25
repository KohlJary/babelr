// SPDX-License-Identifier: MIT
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

  // Escape closes the picker. Capture phase, so it wins over the side panel's
  // and dialogs' Escape (they skip a handled event).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, []);

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
