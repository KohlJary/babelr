// SPDX-License-Identifier: Hippocratic-3.0

const COMMON_EMOJIS = ['👍', '❤️', '😂', '🔥', '👀', '😍', '🎉', '😢', '🤔', '✨', '👏', '🚀'];

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
  onClose: () => void;
}

export function EmojiPicker({ onSelect, onClose }: EmojiPickerProps) {
  return (
    <div className="emoji-picker-overlay" onClick={onClose}>
      <div className="emoji-picker" onClick={(e) => e.stopPropagation()}>
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
    </div>
  );
}
