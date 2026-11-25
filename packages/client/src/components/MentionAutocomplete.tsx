// SPDX-License-Identifier: MIT

/** Someone who can be @mentioned: a server member or a DM participant. */
export interface MentionCandidate {
  id: string;
  preferredUsername: string;
  displayName: string | null;
}

const MAX_SUGGESTIONS = 8;

/**
 * The @token being typed at the caret, if any: the text after an `@` that
 * starts the input or follows whitespace, made only of username characters
 * (the server's parseMentions matches `@(\w+)`).
 */
export function mentionQueryAt(
  text: string,
  caret: number,
): { query: string; start: number } | null {
  const m = /(^|\s)@(\w*)$/.exec(text.slice(0, caret));
  if (!m) return null;
  return { query: m[2], start: caret - m[2].length - 1 };
}

/** Candidates for a query: username prefix first, then display-name matches. */
export function matchMentionCandidates<T extends MentionCandidate>(
  candidates: T[],
  query: string,
): T[] {
  const q = query.toLowerCase();
  const scored: Array<{ c: T; score: number }> = [];
  for (const c of candidates) {
    const user = c.preferredUsername.toLowerCase();
    const display = (c.displayName ?? '').toLowerCase();
    let score = -1;
    if (user.startsWith(q)) score = 0;
    else if (display.split(/\s+/).some((w) => w.startsWith(q))) score = 1;
    else if (user.includes(q) || display.includes(q)) score = 2;
    if (score >= 0) scored.push({ c, score });
  }
  scored.sort(
    (a, b) => a.score - b.score || a.c.preferredUsername.localeCompare(b.c.preferredUsername),
  );
  return scored.slice(0, MAX_SUGGESTIONS).map((s) => s.c);
}

interface MentionAutocompleteProps {
  users: MentionCandidate[];
  activeIndex: number;
  onSelect: (username: string) => void;
  onHover?: (index: number) => void;
  listId?: string;
}

export function MentionAutocomplete({
  users,
  activeIndex,
  onSelect,
  onHover,
  listId,
}: MentionAutocompleteProps) {
  if (users.length === 0) {
    return null;
  }

  return (
    <div className="mention-autocomplete" role="listbox" id={listId} aria-label="Mention someone">
      {users.map((user, i) => (
        <button
          key={user.id}
          type="button"
          id={listId ? `${listId}-${i}` : undefined}
          role="option"
          aria-selected={i === activeIndex}
          className={`mention-ac-item${i === activeIndex ? ' active' : ''}`}
          // mousedown, not click: keep focus (and the caret) in the composer
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(user.preferredUsername);
          }}
          onMouseEnter={() => onHover?.(i)}
        >
          <span className="mention-username">@{user.preferredUsername}</span>
          {user.displayName && <span className="mention-display">{user.displayName}</span>}
        </button>
      ))}
    </div>
  );
}
