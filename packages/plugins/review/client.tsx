// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { Decision, ReviewItem, ReviewMessage } from './manifest.js';

/**
 * The review view: every item down the side, one draft in the middle,
 * and a chat with the agent about it on the right.
 *
 *   A approve · H hold · V veto (asks why) · E edit · C chat
 *   J / → next · K / ← previous · Ctrl+Enter saves a veto or an edit
 *
 * Ask for a change in the chat and the agent can revise the draft: the
 * new version replaces it in place and comes back undecided.
 *
 * Text renders raw (pre-wrap), never through the translation pipeline:
 * a draft is reviewed exactly as it would go out.
 */

export async function fetchInbox(routeBase: string): Promise<ReviewItem[]> {
  const res = await fetch(`${routeBase}/inbox`, { credentials: 'include', cache: 'no-store' });
  if (res.status === 401 || res.status === 403) return [];
  if (!res.ok) throw new Error(res.statusText);
  return (await res.json()) as ReviewItem[];
}

async function fetchHistory(routeBase: string): Promise<ReviewItem[]> {
  const res = await fetch(`${routeBase}/history`, { credentials: 'include', cache: 'no-store' });
  if (!res.ok) return [];
  return (await res.json()) as ReviewItem[];
}

async function send<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

async function fetchMessages(routeBase: string, id: string): Promise<ReviewMessage[]> {
  const res = await fetch(`${routeBase}/items/${id}/messages`, {
    credentials: 'include',
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(res.statusText);
  return (await res.json()) as ReviewMessage[];
}

const LABEL: Record<Decision, string> = {
  approve: 'Approved',
  hold: 'Held',
  veto: 'Vetoed',
  edit: 'Edited',
};

/** Undecided first, then held, then decided-and-waiting-for-the-agent. */
function rank(it: ReviewItem): number {
  return it.decision === null ? 0 : it.decision === 'hold' ? 1 : 2;
}

const agentName = (it: ReviewItem) => it.agent.displayName ?? it.agent.preferredUsername;

type Mode = 'view' | 'veto' | 'edit';
type Tab = 'open' | 'decided';

/** How a closed item ended, for the Decided tab. */
function outcome(it: ReviewItem): string {
  if (it.decision === 'approve') return 'Approved';
  if (it.decision === 'veto') return it.reason ? `Vetoed: ${it.reason}` : 'Vetoed';
  return 'Decided elsewhere (the DM, or the command line)';
}

export function ReviewView({ routeBase, onClose }: { routeBase: string; onClose: () => void }) {
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [history, setHistory] = useState<ReviewItem[]>([]);
  const [tab, setTab] = useState<Tab>('open');
  const [error, setError] = useState<string | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('view');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const chatRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    try {
      const [open, closed] = await Promise.all([fetchInbox(routeBase), fetchHistory(routeBase)]);
      setItems(open);
      setHistory(closed);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [routeBase]);

  useEffect(() => {
    void load();
    // New drafts arrive and acted-on ones close while you work.
    const id = setInterval(() => void load(), 30_000);
    return () => clearInterval(id);
  }, [load]);

  const ordered = useMemo(() => (items ?? []).slice().sort((a, b) => rank(a) - rank(b)), [items]);
  const shown = tab === 'open' ? ordered : history;
  const index = Math.max(
    0,
    shown.findIndex((it) => it.id === currentId),
  );
  const current = shown[index] ?? null;
  const readOnly = tab === 'decided';
  const undecided = ordered.filter((it) => it.decision === null).length;
  const decided = ordered.length - undecided;

  // Land on the first undecided item, and stay put across refetches.
  useEffect(() => {
    if (!currentId || !shown.some((it) => it.id === currentId)) {
      setCurrentId(shown[0]?.id ?? null);
    }
  }, [shown, currentId]);

  const switchTab = useCallback((t: Tab) => {
    setTab(t);
    setCurrentId(null);
    setMode('view');
  }, []);

  const jump = useCallback((id: string) => {
    setCurrentId(id);
    setMode('view');
  }, []);

  const go = useCallback(
    (delta: number) => {
      if (shown.length === 0) return;
      jump(shown[(index + delta + shown.length) % shown.length].id);
    },
    [shown, index, jump],
  );

  const submit = useCallback(
    async (decision: Decision, extra: { reason?: string; body?: string } = {}) => {
      if (!current || busy) return;
      setBusy(true);
      setError(null);
      try {
        const updated = await send<ReviewItem>(`${routeBase}/items/${current.id}/decision`, {
          decision,
          ...extra,
        });
        const after = (items ?? []).map((it) => (it.id === updated.id ? updated : it));
        setItems(after);
        setMode('view');
        // On to the next one still waiting on you, if there is one.
        const order = after.slice().sort((a, b) => rank(a) - rank(b));
        const pos = order.findIndex((it) => it.id === updated.id);
        const next =
          order.slice(pos + 1).find((it) => it.decision === null) ??
          order.find((it) => it.decision === null);
        if (next) setCurrentId(next.id);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [current, busy, routeBase, items],
  );

  const startVeto = useCallback(() => {
    setDraft(current?.decision === 'veto' ? current.reason : '');
    setMode('veto');
  }, [current]);
  const startEdit = useCallback(() => {
    setDraft(current?.editedBody ?? current?.body ?? '');
    setMode('edit');
  }, [current]);

  useEffect(() => {
    if (mode !== 'view') textRef.current?.focus();
  }, [mode]);

  const save = useCallback(() => {
    if (mode === 'veto' && draft.trim()) void submit('veto', { reason: draft.trim() });
    if (mode === 'edit' && draft.trim()) void submit('edit', { body: draft });
  }, [mode, draft, submit]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (mode !== 'view') {
        if (e.key === 'Escape') setMode('view');
        else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save();
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (readOnly && !['j', 'k', 'arrowleft', 'arrowright'].includes(k)) return;
      if (k === 'a') void submit('approve');
      else if (k === 'h') void submit('hold');
      else if (k === 'v') startVeto();
      else if (k === 'e') startEdit();
      else if (k === 'c') chatRef.current?.focus();
      else if (k === 'j' || e.key === 'ArrowRight') go(1);
      else if (k === 'k' || e.key === 'ArrowLeft') go(-1);
      else return;
      e.preventDefault();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, save, submit, startVeto, startEdit, go, readOnly]);

  return (
    <div className="review-view">
      <header className="review-bar">
        <button type="button" className="review-secondary" onClick={onClose}>
          ← Back
        </button>
        <span className="review-count">
          {items === null ? 'Loading…' : undecided ? `${undecided} waiting on you` : 'All decided'}
        </span>
        <button type="button" className="review-secondary" onClick={() => void load()}>
          Refresh
        </button>
      </header>
      {ordered.length > 0 && (
        <div
          className="review-progress"
          role="progressbar"
          aria-label="Decided"
          aria-valuemin={0}
          aria-valuemax={ordered.length}
          aria-valuenow={decided}
        >
          <span style={{ width: `${(decided / ordered.length) * 100}%` }} />
        </div>
      )}
      {error && <div className="review-error">{error}</div>}

      {items !== null && (
        <div className={`review-layout${readOnly ? ' review-layout-history' : ''}`}>
          <div className="review-side">
            <div className="review-tabs" role="tablist" aria-label="Which items">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'open'}
                className={tab === 'open' ? 'review-tab-current' : ''}
                onClick={() => switchTab('open')}
              >
                To decide ({ordered.length})
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'decided'}
                className={tab === 'decided' ? 'review-tab-current' : ''}
                onClick={() => switchTab('decided')}
              >
                Decided ({history.length})
              </button>
            </div>
            <ItemList
              items={shown}
              currentId={current?.id ?? null}
              onJump={jump}
              history={readOnly}
            />
          </div>

          {!current && (
            <p className="review-empty">
              {readOnly
                ? 'Nothing decided yet. Approved and vetoed items land here.'
                : 'Nothing waiting on you here. Outreach drafts are decided in Plans now: open Plans, then On you.'}
            </p>
          )}

          {current && readOnly && (
            <div className="review-main">
              <article className="review-item" aria-labelledby="review-title">
                <div className="review-item-top">
                  <span className="review-position">
                    {index + 1} / {shown.length}
                  </span>
                  <span className="review-from">
                    from {agentName(current)}
                    {current.closedAt
                      ? ` · closed ${new Date(current.closedAt).toLocaleString()}`
                      : ''}
                  </span>
                </div>
                <h2 id="review-title" className="review-title">
                  <span className="review-ref">{current.ref}</span> {current.title}
                </h2>
                {current.meta && <div className="review-meta">{current.meta}</div>}
                <div className={`review-decided review-decided-${current.decision ?? 'hold'}`}>
                  {outcome(current)}
                </div>
                {current.why && (
                  <section className="review-why">
                    <h3>Why</h3>
                    <p>{current.why}</p>
                  </section>
                )}
                <DraftView title="Draft as decided" text={current.editedBody ?? current.body} />
              </article>
            </div>
          )}

          {current && !readOnly && (
            <div className="review-main">
              <article className="review-item" aria-labelledby="review-title">
                <div className="review-item-top">
                  <span className="review-position">
                    {index + 1} / {ordered.length}
                  </span>
                  <span className="review-from">
                    from {agentName(current)}
                    {current.revision > 1 ? ` · revision ${current.revision}` : ''}
                  </span>
                </div>
                <h2 id="review-title" className="review-title">
                  <span className="review-ref">{current.ref}</span> {current.title}
                </h2>
                {current.meta && <div className="review-meta">{current.meta}</div>}
                {current.decision && (
                  <div className={`review-decided review-decided-${current.decision}`}>
                    {LABEL[current.decision]}
                    {current.decision === 'veto' && current.reason ? `: ${current.reason}` : ''}
                    {current.decision !== 'hold' &&
                      ` · ${agentName(current)} picks it up shortly; you can still change it`}
                  </div>
                )}
                {current.why && (
                  <section className="review-why">
                    <h3>Why</h3>
                    <p>{current.why}</p>
                  </section>
                )}
                <DraftView
                  title={current.decision === 'edit' ? 'Draft (your edit)' : 'Draft'}
                  text={current.editedBody ?? current.body}
                />

                {mode !== 'view' && (
                  <section className="review-compose">
                    <label htmlFor="review-text">
                      {mode === 'veto'
                        ? 'Why veto it? The agent learns from this.'
                        : 'Your version of the draft'}
                    </label>
                    <textarea
                      id="review-text"
                      ref={textRef}
                      value={draft}
                      rows={mode === 'edit' ? 16 : 4}
                      onChange={(e) => setDraft(e.target.value)}
                    />
                    <div className="review-compose-actions">
                      <button
                        type="button"
                        className="review-secondary"
                        onClick={() => setMode('view')}
                      >
                        Cancel <kbd>Esc</kbd>
                      </button>
                      <button
                        type="button"
                        className={mode === 'veto' ? 'review-veto' : 'review-primary'}
                        disabled={busy || !draft.trim()}
                        onClick={save}
                      >
                        {mode === 'veto' ? 'Veto' : 'Save edit'} <kbd>Ctrl+Enter</kbd>
                      </button>
                    </div>
                  </section>
                )}
              </article>

              {mode === 'view' && (
                <nav className="review-actions" aria-label="Decide">
                  <button
                    type="button"
                    className="review-nav"
                    onClick={() => go(-1)}
                    aria-label="Previous"
                  >
                    ←
                  </button>
                  <button
                    type="button"
                    className="review-primary"
                    disabled={busy}
                    onClick={() => void submit('approve')}
                  >
                    Approve <kbd>A</kbd>
                  </button>
                  <button type="button" disabled={busy} onClick={() => void submit('hold')}>
                    Hold <kbd>H</kbd>
                  </button>
                  <button type="button" className="review-veto" disabled={busy} onClick={startVeto}>
                    Veto <kbd>V</kbd>
                  </button>
                  <button type="button" disabled={busy} onClick={startEdit}>
                    Edit <kbd>E</kbd>
                  </button>
                  <button
                    type="button"
                    className="review-nav"
                    onClick={() => go(1)}
                    aria-label="Next"
                  >
                    →
                  </button>
                </nav>
              )}
            </div>
          )}

          {current && !readOnly && (
            <ItemChat
              key={current.id}
              routeBase={routeBase}
              item={current}
              inputRef={chatRef}
              onAgentReplied={load}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ── The draft ────────────────────────────────────────────────────────

type DraftMode = 'rendered' | 'markdown';
const DRAFT_MODE_KEY = 'review.draftMode';

function storedMode(): DraftMode {
  try {
    return localStorage.getItem(DRAFT_MODE_KEY) === 'markdown' ? 'markdown' : 'rendered';
  } catch {
    return 'rendered';
  }
}

/** The draft as it reads once published: standard markdown (a single
 *  newline doesn't break a line), sanitized. */
export function renderDraft(text: string): string {
  const html = marked.parse(text, { gfm: true, breaks: false, async: false }) as string;
  return DOMPurify.sanitize(html);
}

/** Put the draft on the clipboard as rich text (and plain text), so it
 *  pastes into Substack or an email with its formatting. */
async function copyRich(text: string): Promise<void> {
  const html = renderDraft(text);
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      }),
    ]);
    return;
  }
  // Older browsers: select a rendered copy and let the browser copy it.
  const holder = document.createElement('div');
  holder.innerHTML = html;
  holder.style.position = 'fixed';
  holder.style.left = '-9999px';
  document.body.appendChild(holder);
  const range = document.createRange();
  range.selectNodeContents(holder);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  const ok = document.execCommand('copy');
  sel?.removeAllRanges();
  holder.remove();
  if (!ok) throw new Error('the browser refused to copy');
}

function DraftView({ title, text }: { title: string; text: string }) {
  const [mode, setMode] = useState<DraftMode>(storedMode);
  const [copied, setCopied] = useState<string | null>(null);
  const html = useMemo(() => (mode === 'rendered' ? renderDraft(text) : ''), [mode, text]);

  const pick = (m: DraftMode) => {
    setMode(m);
    try {
      localStorage.setItem(DRAFT_MODE_KEY, m);
    } catch {
      // a remembered preference is a convenience
    }
  };

  const copy = async () => {
    try {
      await copyRich(text);
      setCopied('Copied with formatting. Paste it into Substack.');
    } catch (err) {
      setCopied(`Couldn't copy: ${(err as Error).message}`);
    }
    setTimeout(() => setCopied(null), 4000);
  };

  return (
    <section className="review-draft">
      <div className="review-draft-head">
        <h3>{title}</h3>
        <div className="review-draft-tools">
          <div className="review-toggle" role="group" aria-label="Show the draft as">
            <button
              type="button"
              aria-pressed={mode === 'rendered'}
              onClick={() => pick('rendered')}
            >
              Rendered
            </button>
            <button
              type="button"
              aria-pressed={mode === 'markdown'}
              onClick={() => pick('markdown')}
            >
              Markdown
            </button>
          </div>
          <button type="button" className="review-copy" onClick={() => void copy()}>
            Copy for Substack
          </button>
        </div>
      </div>
      {mode === 'rendered' ? (
        <div
          className="review-body review-body-rendered"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <div className="review-body">{text}</div>
      )}
      {copied && (
        <div className="review-copied" role="status">
          {copied}
        </div>
      )}
    </section>
  );
}

// ── The list ─────────────────────────────────────────────────────────

function ItemList({
  items,
  currentId,
  onJump,
  history,
}: {
  items: ReviewItem[];
  currentId: string | null;
  onJump: (id: string) => void;
  history: boolean;
}) {
  return (
    <nav className="review-list" aria-label="Items">
      <ul>
        {items.map((it) => (
          <li key={it.id}>
            <button
              type="button"
              className={`review-list-item${it.id === currentId ? ' review-list-current' : ''}`}
              aria-current={it.id === currentId ? 'true' : undefined}
              onClick={() => onJump(it.id)}
            >
              <span className="review-list-top">
                <span className="review-ref">{it.ref}</span>
                {it.decision ? (
                  <span className={`review-badge review-badge-${it.decision}`}>
                    {LABEL[it.decision]}
                  </span>
                ) : history ? (
                  <span className="review-badge">Elsewhere</span>
                ) : (
                  <span className="review-badge review-badge-new">To decide</span>
                )}
              </span>
              <span className="review-list-title">{it.title}</span>
              {!history && it.messageCount > 0 && (
                <span className="review-list-chat">
                  💬 {it.messageCount}
                  {it.awaitingReply ? ` · ${agentName(it)} is replying…` : ''}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// ── The chat ─────────────────────────────────────────────────────────

function ItemChat({
  routeBase,
  item,
  inputRef,
  onAgentReplied,
}: {
  routeBase: string;
  item: ReviewItem;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onAgentReplied: () => Promise<void>;
}) {
  const [messages, setMessages] = useState<ReviewMessage[] | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const seen = useRef(0);
  const awaiting = messages?.at(-1)?.from === 'reviewer';
  const name = agentName(item);

  const refresh = useCallback(async () => {
    try {
      const fresh = await fetchMessages(routeBase, item.id);
      // The agent answered: its revision (if any) is on the item now.
      if (seen.current && fresh.length > seen.current && fresh.at(-1)?.from === 'agent') {
        void onAgentReplied();
      }
      seen.current = fresh.length;
      setMessages(fresh);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [routeBase, item.id, onAgentReplied]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Quick while a reply is owed, slow otherwise.
  useEffect(() => {
    const id = setInterval(() => void refresh(), awaiting ? 4000 : 20_000);
    return () => clearInterval(id);
  }, [refresh, awaiting]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages?.length]);

  const post = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      const fresh = await send<ReviewMessage[]>(`${routeBase}/items/${item.id}/messages`, {
        body,
      });
      seen.current = fresh.length;
      setMessages(fresh);
      setText('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <aside className="review-chat" aria-label={`Talk it over with ${name}`}>
      <h3>Talk it over with {name}</h3>
      <div className="review-chat-log" aria-live="polite">
        {messages === null && <p className="review-chat-hint">Loading…</p>}
        {messages?.length === 0 && (
          <p className="review-chat-hint">
            Ask for changes here ("shorter", "lose the PS", "why this person?"). {name} answers, and
            can put up a revised draft, which comes back to you undecided.
          </p>
        )}
        {messages?.map((m) => (
          <div key={m.id} className={`review-msg review-msg-${m.from}`}>
            <span className="review-msg-who">{m.from === 'agent' ? name : 'You'}</span>
            <div className="review-msg-body">{m.body}</div>
          </div>
        ))}
        {awaiting && (
          <p className="review-chat-hint" role="status">
            {name} is replying…
          </p>
        )}
        <div ref={endRef} />
      </div>
      {error && <div className="review-error">{error}</div>}
      <div className="review-chat-compose">
        <textarea
          ref={inputRef}
          value={text}
          rows={3}
          placeholder={`Message ${name} about ${item.ref}`}
          aria-label={`Message ${name} about ${item.ref}`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void post();
            } else if (e.key === 'Escape') {
              (e.target as HTMLTextAreaElement).blur();
            }
          }}
        />
        <button type="button" disabled={sending || !text.trim()} onClick={() => void post()}>
          Send
        </button>
      </div>
    </aside>
  );
}
