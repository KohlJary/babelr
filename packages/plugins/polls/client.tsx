// SPDX-License-Identifier: Hippocratic-3.0
import { useEffect, useState, useCallback } from 'react';
import type { PollPayload } from './manifest.js';
// In-tree plugins import client-internal components directly.
// Phase 5's npm distribution reroutes this through a stable re-export.
import { ListDetailView } from '../../client/src/components/ListDetailView.js';
import { T } from '../../client/src/components/T.js';
import { onWsMessage } from '../../client/src/plugins/ws-helper.js';

/**
 * Client components for the polls plugin. Kept in a separate file so
 * manifest.ts stays runtime-agnostic (the server imports it too) —
 * setupClient lazy-imports this module so React only gets pulled in
 * the browser build.
 *
 * Real-time sync: the server broadcasts `plugin:polls:updated` over
 * the main WebSocket on every vote and close. We piggyback on window-
 * level event dispatch so components don't need their own WS handle
 * and can share a single subscription from a module-level listener.
 */

interface PollViewProps {
  slug: string;
  serverSlug?: string;
  routeBase: string;
}

// Module-level cache + inflight dedupe, same pattern built-in embeds
// use. Keyed by slug (serverSlug support for cross-server is a future
// extension — polls don't federate via the server slug today).
const cache = new Map<string, PollPayload>();
const inflight = new Map<string, Promise<PollPayload | null>>();

async function fetchPoll(
  slug: string,
  routeBase: string,
): Promise<PollPayload | null> {
  const cached = cache.get(slug);
  if (cached) return cached;
  const existing = inflight.get(slug);
  if (existing) return existing;
  const promise = fetch(`${routeBase}/polls/${encodeURIComponent(slug)}`, {
    credentials: 'include',
  })
    .then(async (res) => {
      if (!res.ok) return null;
      const data = (await res.json()) as PollPayload;
      cache.set(slug, data);
      inflight.delete(slug);
      return data;
    })
    .catch(() => {
      inflight.delete(slug);
      return null;
    });
  inflight.set(slug, promise);
  return promise;
}

function invalidate(slug: string) {
  cache.delete(slug);
}

/**
 * Cross-component vote-sync. Components mount a listener on this target
 * so a vote in one embed updates every other embed of the same poll
 * without each re-fetching. Fired by the `plugin:polls:updated` WS
 * event (handler set up once, below).
 */
type Listener = (payload: PollPayload) => void;
const listeners = new Map<string, Set<Listener>>();

function subscribe(slug: string, fn: Listener): () => void {
  let set = listeners.get(slug);
  if (!set) {
    set = new Set();
    listeners.set(slug, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(slug);
  };
}

function publish(payload: PollPayload) {
  cache.set(payload.slug, payload);
  listeners.get(payload.slug)?.forEach((fn) => fn(payload));
}

// Subscribe once at module load so every PollEmbed and the PollsView
// see vote updates without wiring their own WS listeners.
onWsMessage<PollPayload>('plugin:polls:updated', (payload) => {
  if (payload) publish(payload);
});

function usePoll(slug: string, routeBase: string): PollPayload | null {
  const [poll, setPoll] = useState<PollPayload | null>(() => cache.get(slug) ?? null);
  useEffect(() => {
    let cancelled = false;
    if (!cache.get(slug)) {
      void fetchPoll(slug, routeBase).then((p) => {
        if (!cancelled && p) setPoll(p);
      });
    }
    const unsub = subscribe(slug, (p) => {
      if (!cancelled) setPoll(p);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [slug, routeBase]);
  return poll;
}

async function castVote(
  slug: string,
  optionId: string,
  routeBase: string,
): Promise<PollPayload | null> {
  const res = await fetch(`${routeBase}/polls/${encodeURIComponent(slug)}/vote`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ optionId }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as PollPayload;
  invalidate(slug);
  publish(data);
  return data;
}

function percent(voteCount: number, totalVotes: number): number {
  if (totalVotes === 0) return 0;
  return Math.round((voteCount / totalVotes) * 100);
}

interface PollCreatorHost {
  actor: { id: string };
  selectedServerId: string | null;
  routeBase: string;
}

/**
 * Sidebar-slot button — opens the Polls view. View is where creation,
 * browsing, and management all live; the sidebar slot is a jump-link.
 */
export function PollsSidebarSlot(props: { host: unknown }) {
  const host = props.host as PollCreatorHost & {
    openView: (id: string) => void;
  };
  return (
    <button
      type="button"
      className="sidebar-item add-channel"
      onClick={() => host.openView('polls')}
    >
      📊 Polls
    </button>
  );
}

interface CreatePollFormProps {
  routeBase: string;
  serverId: string | null;
  onCreated: (poll: PollPayload) => void;
}

function CreatePollForm({ routeBase, serverId, onCreated }: CreatePollFormProps) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setError(null);
    const trimmedOptions = options.map((o) => o.trim()).filter((o) => o.length > 0);
    if (!question.trim()) {
      setError('Question is required.');
      return;
    }
    if (trimmedOptions.length < 2) {
      setError('At least 2 options are required.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`${routeBase}/polls`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: question.trim(),
          options: trimmedOptions,
          serverId,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        setError(body.error ?? 'Failed to create poll');
        setSubmitting(false);
        return;
      }
      const poll = (await res.json()) as PollPayload;
      cache.set(poll.slug, poll);
      onCreated(poll);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };

  return (
    <div className="poll-create-form">
      <h3>Create poll</h3>
      <label className="poll-modal-field">
        <span>Question</span>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={2}
          placeholder="What should we decide?"
        />
      </label>
      <div className="poll-modal-field">
        <span>Options</span>
        {options.map((opt, i) => (
          <div key={i} className="poll-modal-option-row">
            <input
              type="text"
              value={opt}
              onChange={(e) => {
                const next = [...options];
                next[i] = e.target.value;
                setOptions(next);
              }}
              placeholder={`Option ${i + 1}`}
            />
            {options.length > 2 && (
              <button
                type="button"
                className="poll-modal-remove-option"
                onClick={() => setOptions(options.filter((_, j) => j !== i))}
              >
                ×
              </button>
            )}
          </div>
        ))}
        {options.length < 10 && (
          <button
            type="button"
            className="poll-modal-add-option"
            onClick={() => setOptions([...options, ''])}
          >
            + Add option
          </button>
        )}
      </div>
      {error && <div className="poll-modal-error">{error}</div>}
      <div className="poll-modal-actions">
        <button
          type="button"
          className="poll-modal-submit"
          disabled={submitting}
          onClick={() => void handleSubmit()}
        >
          {submitting ? 'Creating…' : 'Create poll'}
        </button>
      </div>
    </div>
  );
}

interface PollsViewProps {
  routeBase: string;
  serverId: string | null;
  serverName: string | null;
  onClose: () => void;
}

interface PollSummary {
  slug: string;
  question: string;
  createdAt: string;
  closedAt: string | null;
}

/**
 * Main-panel polls view — list-detail layout via the shared
 * ListDetailView primitive. Left rail: searchable polls for the
 * current server, plus a "+ New poll" entry point. Main: selected
 * poll's full preview (question + options + live vote counts) or
 * the create form when the user clicks "+ New poll".
 */
export function PollsView(props: PollsViewProps) {
  const { routeBase, serverId, serverName, onClose } = props;
  const [polls, setPolls] = useState<PollSummary[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async () => {
    const url = serverId
      ? `${routeBase}/polls?serverId=${encodeURIComponent(serverId)}`
      : `${routeBase}/polls`;
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return;
    const data = (await res.json()) as PollSummary[];
    setPolls(data);
  }, [routeBase, serverId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Keep the list in sync when a vote update arrives so "closed"
  // state reflects live. We don't receive full summaries over WS —
  // just trigger a refetch on any plugin:polls:updated event.
  useEffect(() => onWsMessage('plugin:polls:updated', () => void reload()), [reload]);

  return (
    <ListDetailView<PollSummary>
      title={serverName ? `Polls · ${serverName}` : 'Polls'}
      items={polls}
      getId={(p) => p.slug}
      getLabel={(p) => p.question}
      getSearchText={(p) => p.question}
      renderItem={(p) => (
        <span className="poll-list-row">
          <span className="poll-list-row-question">{p.question}</span>
          <span className="poll-list-row-meta">
            {new Date(p.createdAt).toLocaleDateString()}
            {p.closedAt && ' · closed'}
          </span>
        </span>
      )}
      selectedId={creating ? null : selectedSlug}
      onSelect={(id) => {
        setCreating(false);
        setSelectedSlug(id);
      }}
      onCreate={() => {
        setCreating(true);
        setSelectedSlug(null);
      }}
      createLabel="New poll"
      emptyListMessage="No polls yet. Click “New poll” to create one."
      searchPlaceholder="Search polls…"
      onClose={onClose}
      renderDetail={(item) => {
        if (creating) {
          return (
            <CreatePollForm
              routeBase={routeBase}
              serverId={serverId}
              onCreated={(poll) => {
                setCreating(false);
                setSelectedSlug(poll.slug);
                void reload();
              }}
            />
          );
        }
        if (!item) {
          return (
            <div className="poll-view-empty">
              Select a poll from the left, or click “New poll” to create one.
            </div>
          );
        }
        return (
          <div className="poll-view-detail">
            <PollPreview slug={item.slug} routeBase={routeBase} />
            <div className="poll-view-embed-hint">
              <span>Embed anywhere:</span>
              <code>{`[[poll:${item.slug}]]`}</code>
              <button
                type="button"
                onClick={() =>
                  void navigator.clipboard.writeText(`[[poll:${item.slug}]]`)
                }
              >
                Copy
              </button>
            </div>
          </div>
        );
      }}
    />
  );
}

export function PollInline(props: Record<string, unknown>) {
  const { slug, routeBase, onClick } = props as unknown as PollViewProps & {
    onClick: () => void;
  };
  const poll = usePoll(slug, routeBase);
  if (!poll) {
    return (
      <button type="button" className="poll-embed loading" onClick={onClick}>
        📊 Loading poll…
      </button>
    );
  }
  const leading = poll.options.reduce(
    (max, o) => (o.voteCount > (max?.voteCount ?? -1) ? o : max),
    poll.options[0] ?? null,
  );
  return (
    <button type="button" className="poll-embed ok" onClick={onClick}>
      <span className="poll-embed-icon">📊</span>
      <span className="poll-embed-body">
        <span className="poll-embed-question">
          <T>{poll.question}</T>
        </span>
        <span className="poll-embed-meta">
          {poll.totalVotes} vote{poll.totalVotes === 1 ? '' : 's'}
          {leading && poll.totalVotes > 0 && (
            <>
              {' · '}
              <em>
                <T>{leading.label}</T>
              </em>{' '}
              leading
            </>
          )}
          {poll.closedAt && <> · closed</>}
        </span>
      </span>
    </button>
  );
}

export function PollPreview(props: Record<string, unknown>) {
  const { slug, routeBase } = props as unknown as PollViewProps;
  const poll = usePoll(slug, routeBase);
  const [voting, setVoting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleVote = useCallback(
    async (optionId: string) => {
      if (!poll || poll.closedAt) return;
      setVoting(optionId);
      setError(null);
      const updated = await castVote(poll.slug, optionId, routeBase);
      if (!updated) setError('Vote failed — try again.');
      setVoting(null);
    },
    [poll, routeBase],
  );

  if (!poll) return <div className="poll-preview-loading">Loading poll…</div>;

  const myVote = poll.myVoteOptionId ?? null;
  const closed = !!poll.closedAt;

  return (
    <div className="poll-preview">
      <h3 className="poll-preview-question">
        <T>{poll.question}</T>
      </h3>
      {closed && <div className="poll-preview-closed-badge">Closed</div>}
      <ul className="poll-preview-options">
        {poll.options.map((opt) => {
          const pct = percent(opt.voteCount, poll.totalVotes);
          const picked = myVote === opt.id;
          return (
            <li
              key={opt.id}
              className={`poll-preview-option${picked ? ' picked' : ''}`}
            >
              <button
                type="button"
                className="poll-preview-option-button"
                disabled={closed || voting !== null}
                onClick={() => void handleVote(opt.id)}
              >
                <span className="poll-preview-option-bar" style={{ width: `${pct}%` }} />
                <span className="poll-preview-option-label">
                  <T>{opt.label}</T>
                </span>
                <span className="poll-preview-option-count">
                  {opt.voteCount} ({pct}%)
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="poll-preview-footer">
        {poll.totalVotes} vote{poll.totalVotes === 1 ? '' : 's'}
        {myVote && !closed && poll.allowRevote && (
          <span className="poll-preview-revote-hint"> · click another option to change your vote</span>
        )}
      </div>
      {error && <div className="poll-preview-error">{error}</div>}
    </div>
  );
}
