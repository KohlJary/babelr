// SPDX-License-Identifier: Hippocratic-3.0
import type { AuthorView } from '@babelr/shared';

interface MentionAutocompleteProps {
  users: AuthorView[];
  onSelect: (username: string) => void;
  onClose: () => void;
}

export function MentionAutocomplete({ users, onSelect, onClose }: MentionAutocompleteProps) {
  if (users.length === 0) {
    return null;
  }

  return (
    <div className="mention-autocomplete">
      {users.map((user) => (
        <button
          key={user.id}
          className="mention-item"
          onClick={() => {
            onSelect(user.preferredUsername);
            onClose();
          }}
        >
          <span className="mention-username">@{user.preferredUsername}</span>
          <span className="mention-display">{user.displayName || 'No display name'}</span>
        </button>
      ))}
    </div>
  );
}
