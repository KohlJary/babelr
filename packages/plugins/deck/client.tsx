// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import {
  cleanHandle,
  parseRef,
  parseSlides,
  refFor,
  slugify,
  type DeckCard,
  type DeckPayload,
  type DeckPerson,
  type DeckSummary,
  type Slide,
} from './deck.js';

/**
 * Client for the deck plugin: the phone-first viewer, the "Ask about this
 * slide" composer, a plain editor, and the [[deck:slug#n]] card.
 *
 * A question is an ordinary DM. The composer opens (or finds) the viewer's
 * DM with the presenter and sends one message, encrypted here with the
 * viewer's own keys like any other DM: `[[deck:slug#n]]`, a blank line,
 * then the question. Nothing about the question goes to the deck plugin.
 */

export interface DMCrypto {
  encrypt: (
    plaintext: string,
    partnerId: string,
  ) => Promise<{ content: string; properties: { encrypted: true; iv: string } }>;
}

async function call<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'include',
    cache: 'no-store',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    const err = new Error(data.error ?? res.statusText) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return data;
}

/** The core API base (`/api`) from this plugin's routeBase (`/api/plugins/deck`). */
const apiBase = (routeBase: string) => routeBase.replace(/\/plugins\/[^/]+$/, '');

function md(text: string): string {
  const html = DOMPurify.sanitize(
    marked.parse(text || '', { gfm: true, breaks: true, async: false }) as string,
  );
  // Links leave the deck in a new tab, so the deck stays where it was.
  return html.replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" ');
}

const nameOf = (p: DeckPerson) => p.displayName || `@${p.handle}`;
const slideLabel = (s: Pick<Slide, 'n' | 'title'>) => s.title || `Slide ${s.n}`;

/** Ask the host to open a view (ChatView listens for this). */
export function openDeck(slug: string, n?: number | null) {
  window.dispatchEvent(
    new CustomEvent('babelr:open-view', { detail: { id: 'deck', state: { slug, n: n ?? 1 } } }),
  );
}

// -- Listing (sidebar availability) ---------------------------------------

export async function fetchDecks(routeBase: string): Promise<DeckSummary[]> {
  return call<DeckSummary[]>(`${routeBase}/decks`);
}

// -- Embed: [[deck:slug]] / [[deck:slug#n]] -------------------------------

type CardState = { kind: 'loading' } | { kind: 'private' } | { kind: 'ok'; card: DeckCard };

const cards = new Map<string, Promise<CardState>>();
function fetchCard(routeBase: string, slug: string): Promise<CardState> {
  let p = cards.get(slug);
  if (!p) {
    p = fetch(`${routeBase}/deck/by-slug/${encodeURIComponent(slug)}`, {
      credentials: 'include',
      cache: 'no-store',
    })
      .then(async (r): Promise<CardState> => {
        if (!r.ok) return { kind: 'private' };
        return { kind: 'ok', card: (await r.json()) as DeckCard };
      })
      .catch((): CardState => ({ kind: 'private' }));
    cards.set(slug, p);
    // Short-lived: an edited title shows up on the next look.
    setTimeout(() => cards.delete(slug), 60_000);
  }
  return p;
}

function useCard(routeBase: string, ref: string) {
  const parsed = parseRef(ref);
  const [state, setState] = useState<CardState>({ kind: 'loading' });
  useEffect(() => {
    if (!parsed) {
      setState({ kind: 'private' });
      return;
    }
    let live = true;
    void fetchCard(routeBase, parsed.slug).then((s) => live && setState(s));
    return () => {
      live = false;
    };
  }, [routeBase, parsed?.slug]);
  return { parsed, state };
}

function CardBody({ card, n }: { card: DeckCard; n: number | null }) {
  const slide = n ? card.slides.find((s) => s.n === n) : undefined;
  return (
    <>
      <span className="deck-card-icon" aria-hidden="true">
        ▦
      </span>
      <span className="deck-card-text">
        <span className="deck-card-title">{card.title}</span>
        <span className="deck-card-meta">
          {slide
            ? `Slide ${slide.n} of ${card.slideCount} · ${slideLabel(slide)}`
            : `${card.slideCount} slide${card.slideCount === 1 ? '' : 's'}`}
        </span>
      </span>
    </>
  );
}

export function DeckInline({ slug, routeBase }: { slug: string; routeBase: string }) {
  const { parsed, state } = useCard(routeBase, slug);
  if (state.kind === 'loading') {
    return <span className="deck-card deck-card-muted">Deck…</span>;
  }
  if (state.kind === 'private' || !parsed) {
    return (
      <span className="deck-card deck-card-muted" title="You can't see this deck">
        <span className="deck-card-icon" aria-hidden="true">
          ▦
        </span>
        a private deck
      </span>
    );
  }
  return (
    <button
      type="button"
      className="deck-card"
      onClick={(e) => {
        e.stopPropagation();
        openDeck(parsed.slug, parsed.n);
      }}
      aria-label={`Open the deck ${state.card.title}${parsed.n ? `, slide ${parsed.n}` : ''}`}
    >
      <CardBody card={state.card} n={parsed.n} />
    </button>
  );
}

export function DeckPreview({
  slug,
  routeBase,
  onNavigate,
}: {
  slug: string;
  routeBase: string;
  onNavigate: () => void;
}) {
  const { parsed, state } = useCard(routeBase, slug);
  if (state.kind === 'loading') return <p className="deck-muted">Loading…</p>;
  if (state.kind === 'private' || !parsed) return <p className="deck-muted">A private deck.</p>;
  return (
    <div className="deck-preview">
      <div className="deck-card deck-card-static">
        <CardBody card={state.card} n={parsed.n} />
      </div>
      <ol className="deck-preview-list">
        {state.card.slides.map((s) => (
          <li key={s.n} className={s.n === parsed.n ? 'deck-current' : undefined}>
            {slideLabel(s)}
          </li>
        ))}
      </ol>
      <button type="button" className="deck-primary" onClick={onNavigate}>
        Open the deck
      </button>
    </div>
  );
}

// -- The view ---------------------------------------------------------------

interface Host {
  closeView: () => void;
  startDM?: (actorId: string) => void;
  openDrawer?: () => void;
  actor: { id: string; preferredUsername: string };
  selectedServer: { id: string; name: string } | null;
}

type Mode =
  | { kind: 'list' }
  | { kind: 'show'; slug: string; n: number }
  | { kind: 'edit'; slug: string | null };

export function DecksView({
  routeBase,
  host,
  viewState,
  dm,
  onListChanged,
}: {
  routeBase: string;
  host: Host;
  viewState: Record<string, unknown>;
  dm: DMCrypto;
  onListChanged: () => void;
}) {
  const fromState = (): Mode => {
    const slug = typeof viewState.slug === 'string' ? viewState.slug : null;
    const n = Number(viewState.n);
    return slug
      ? { kind: 'show', slug, n: Number.isInteger(n) && n > 0 ? n : 1 }
      : { kind: 'list' };
  };
  const [mode, setMode] = useState<Mode>(fromState);
  // A link or a card opened while the view is already open.
  useEffect(() => {
    setMode(fromState());
  }, [viewState.slug, viewState.n]);

  if (mode.kind === 'show') {
    return (
      <DeckViewer
        key={mode.slug}
        routeBase={routeBase}
        slug={mode.slug}
        initial={mode.n}
        host={host}
        dm={dm}
        onBack={() => setMode({ kind: 'list' })}
        onEdit={() => setMode({ kind: 'edit', slug: mode.slug })}
      />
    );
  }
  if (mode.kind === 'edit') {
    return (
      <DeckEditor
        routeBase={routeBase}
        slug={mode.slug}
        host={host}
        onDone={(slug) => {
          onListChanged();
          setMode(slug ? { kind: 'show', slug, n: 1 } : { kind: 'list' });
        }}
      />
    );
  }
  return (
    <DeckList
      routeBase={routeBase}
      host={host}
      onOpen={(slug) => setMode({ kind: 'show', slug, n: 1 })}
      onNew={() => setMode({ kind: 'edit', slug: null })}
    />
  );
}

function DeckList({
  routeBase,
  host,
  onOpen,
  onNew,
}: {
  routeBase: string;
  host: Host;
  onOpen: (slug: string) => void;
  onNew: () => void;
}) {
  const [decks, setDecks] = useState<DeckSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetchDecks(routeBase).then(setDecks, (e: Error) => setError(e.message));
  }, [routeBase]);
  return (
    <div className="deck-root deck-list-view">
      <header className="deck-bar">
        <h2 className="deck-bar-title">Decks</h2>
        <div className="deck-bar-actions">
          <button type="button" className="deck-secondary" onClick={onNew}>
            New deck
          </button>
          <button
            type="button"
            className="deck-icon-btn"
            onClick={host.closeView}
            aria-label="Close decks"
          >
            ×
          </button>
        </div>
      </header>
      {error && <p className="deck-error">{error}</p>}
      {decks === null && !error && <p className="deck-muted">Loading…</p>}
      {decks?.length === 0 && <p className="deck-muted">No decks you can see yet.</p>}
      <ul className="deck-list">
        {decks?.map((d) => (
          <li key={d.slug}>
            <button type="button" className="deck-list-item" onClick={() => onOpen(d.slug)}>
              <span className="deck-list-title">{d.title}</span>
              <span className="deck-list-meta">
                {d.slideCount} slide{d.slideCount === 1 ? '' : 's'}
                {d.presenters.length > 0 &&
                  ` · presented by ${d.presenters.map(nameOf).join(', ')}`}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DeckViewer({
  routeBase,
  slug,
  initial,
  host,
  dm,
  onBack,
  onEdit,
}: {
  routeBase: string;
  slug: string;
  initial: number;
  host: Host;
  dm: DMCrypto;
  onBack: () => void;
  onEdit: () => void;
}) {
  const [deck, setDeck] = useState<DeckPayload | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(initial);
  const [dir, setDir] = useState<'next' | 'prev' | null>(null);
  const [asking, setAsking] = useState(false);
  const [dx, setDx] = useState(0);
  // The drag so far, read when the finger lifts (state may lag a frame).
  const dragged = useRef(0);
  const touch = useRef<{ x: number; y: number; horizontal: boolean | null } | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    call<DeckPayload>(`${routeBase}/decks/${encodeURIComponent(slug)}`).then(
      (d) => {
        setDeck(d);
        setN((cur) => Math.min(Math.max(1, cur), d.slides.length));
      },
      (e: Error & { status?: number }) =>
        e.status === 404 ? setMissing(true) : setError(e.message),
    );
  }, [routeBase, slug]);
  useEffect(() => setN(initial), [initial]);

  const count = deck?.slides.length ?? 0;
  const go = useCallback(
    (to: number) => {
      if (!count) return;
      const next = Math.min(Math.max(1, to), count);
      setN((cur) => {
        if (next !== cur) setDir(next > cur ? 'next' : 'prev');
        return next;
      });
    },
    [count],
  );

  useEffect(() => {
    if (asking) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') go(n + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(n - 1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, n, asking]);

  const presenters = useMemo(
    () => (deck?.presenters ?? []).filter((p) => p.id !== host.actor.id),
    [deck, host.actor.id],
  );

  if (missing) {
    return (
      <div className="deck-root deck-viewer">
        <header className="deck-bar">
          <button type="button" className="deck-back" onClick={onBack} aria-label="Back to decks">
            ‹
          </button>
          <span className="deck-bar-title">Decks</span>
        </header>
        <div className="deck-refused" role="status">
          <span className="deck-card-icon" aria-hidden="true">
            ▦
          </span>
          <p>This is a private deck.</p>
          <p className="deck-muted">Only the people it was made for can see it.</p>
        </div>
      </div>
    );
  }
  if (!deck) {
    return (
      <div className="deck-root">
        <p className={error ? 'deck-error' : 'deck-muted'}>{error ?? 'Loading…'}</p>
      </div>
    );
  }
  const slide = deck.slides[n - 1] ?? deck.slides[0];

  // Swipe with a finger (or pen): pointer events, with touch-action: pan-y on
  // the stage so a vertical drag still scrolls a long slide. A mouse doesn't
  // drag (it selects text); it has the arrows and the keyboard.
  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.pointerType === 'mouse') return;
    touch.current = { x: e.clientX, y: e.clientY, horizontal: null };
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const s = touch.current;
    if (!s) return;
    const mx = e.clientX - s.x;
    const my = e.clientY - s.y;
    if (s.horizontal === null && Math.abs(mx) + Math.abs(my) > 8) {
      s.horizontal = Math.abs(mx) > Math.abs(my);
      if (s.horizontal) e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    if (s.horizontal) {
      // Resist at the ends, so the first and last slide feel like edges.
      const edge = (n === 1 && mx > 0) || (n === count && mx < 0);
      dragged.current = edge ? mx / 4 : mx;
      setDx(dragged.current);
    }
  };
  const onPointerEnd = (e: ReactPointerEvent) => {
    if (!touch.current) return;
    const moved = e.type === 'pointercancel' ? 0 : dragged.current;
    dragged.current = 0;
    touch.current = null;
    setDx(0);
    if (moved < -60) go(n + 1);
    else if (moved > 60) go(n - 1);
  };

  return (
    <div className="deck-root deck-viewer">
      <header className="deck-bar">
        <button type="button" className="deck-back" onClick={onBack} aria-label="Back to decks">
          ‹
        </button>
        <span className="deck-bar-title deck-ellipsis">{deck.title}</span>
        <span className="deck-counter" aria-live="polite">
          {slide.n} / {count}
        </span>
        {deck.canEdit && (
          <button type="button" className="deck-secondary deck-small" onClick={onEdit}>
            Edit
          </button>
        )}
      </header>
      <div
        className="deck-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        <article
          key={slide.n}
          className={`deck-slide${dir ? ` deck-slide-${dir}` : ''}${dx ? ' deck-dragging' : ''}`}
          style={dx ? { transform: `translateX(${dx}px)` } : undefined}
          aria-roledescription="slide"
          aria-label={`Slide ${slide.n} of ${count}`}
        >
          {slide.title && (
            <h1 className="deck-slide-title" ref={titleRef}>
              {slide.title}
            </h1>
          )}
          <div className="deck-slide-body" dangerouslySetInnerHTML={{ __html: md(slide.body) }} />
        </article>
      </div>
      <footer className="deck-foot">
        {presenters.length > 0 && (
          <button type="button" className="deck-ask" onClick={() => setAsking(true)}>
            <span aria-hidden="true">💬</span> Ask about this slide
          </button>
        )}
        <nav className="deck-nav" aria-label="Slides">
          <button
            type="button"
            className="deck-nav-btn"
            onClick={() => go(n - 1)}
            disabled={n <= 1}
            aria-label="Previous slide"
          >
            ‹
          </button>
          {count <= 15 ? (
            <span className="deck-dots" aria-hidden="true">
              {deck.slides.map((s) => (
                <span key={s.n} className={s.n === slide.n ? 'deck-dot deck-dot-on' : 'deck-dot'} />
              ))}
            </span>
          ) : (
            <span className="deck-muted">
              {slide.n} / {count}
            </span>
          )}
          <button
            type="button"
            className="deck-nav-btn"
            onClick={() => go(n + 1)}
            disabled={n >= count}
            aria-label="Next slide"
          >
            ›
          </button>
        </nav>
      </footer>
      {asking && (
        <AskSheet
          routeBase={routeBase}
          deck={deck}
          slide={slide}
          presenters={presenters}
          dm={dm}
          host={host}
          onClose={() => setAsking(false)}
        />
      )}
    </div>
  );
}

function AskSheet({
  routeBase,
  deck,
  slide,
  presenters,
  dm,
  host,
  onClose,
}: {
  routeBase: string;
  deck: DeckPayload;
  slide: Slide;
  presenters: DeckPerson[];
  dm: DMCrypto;
  host: Host;
  onClose: () => void;
}) {
  const [to, setTo] = useState<DeckPerson>(presenters[0]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<DeckPerson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const textId = useId();
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => box.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const send = async () => {
    const q = text.trim();
    if (!q || sending) return;
    setSending(true);
    setError(null);
    try {
      const api = apiBase(routeBase);
      const conv = await call<{ id: string }>(`${api}/dms`, 'POST', { participantId: to.id });
      const body = await dm.encrypt(`${refFor(deck.slug, slide.n)}\n\n${q}`, to.id);
      await call(`${api}/dms/${conv.id}/messages`, 'POST', body);
      setSent(to);
      setText('');
    } catch (e) {
      setError(
        (e as Error).message.includes('encrypt')
          ? `Can't send to ${nameOf(to)} yet: there's no key to encrypt to. Try again in a moment.`
          : (e as Error).message,
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="deck-sheet-scrim" onClick={onClose}>
      <div
        className="deck-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Ask about this slide"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="deck-sheet-head">
          <h2>{sent ? 'Sent' : 'Ask about this slide'}</h2>
          <button type="button" className="deck-icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="deck-card deck-card-static">
          <CardBody
            card={{
              slug: deck.slug,
              title: deck.title,
              slideCount: deck.slides.length,
              slides: [{ n: slide.n, title: slide.title }],
            }}
            n={slide.n}
          />
        </div>
        {sent ? (
          <>
            <p className="deck-sheet-note">
              {nameOf(sent)} has your question, with this slide attached. Their answer comes to your
              messages.
            </p>
            <div className="deck-sheet-actions">
              <button type="button" className="deck-secondary" onClick={onClose}>
                Back to the deck
              </button>
              {host.startDM && (
                <button
                  type="button"
                  className="deck-primary"
                  onClick={() => host.startDM!(sent.id)}
                >
                  Open the conversation
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            {presenters.length > 1 && (
              <fieldset className="deck-picker">
                <legend>Ask</legend>
                {presenters.map((p) => (
                  <label
                    key={p.id}
                    className={p.id === to.id ? 'deck-chip deck-chip-on' : 'deck-chip'}
                  >
                    <input
                      type="radio"
                      name="deck-presenter"
                      checked={p.id === to.id}
                      onChange={() => setTo(p)}
                    />
                    {nameOf(p)}
                  </label>
                ))}
              </fieldset>
            )}
            <label htmlFor={textId} className="deck-field-label">
              Your question or comment for {nameOf(to)}
            </label>
            <textarea
              id={textId}
              ref={box}
              className="deck-textarea"
              rows={4}
              value={text}
              placeholder={`About “${slideLabel(slide)}”…`}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
              }}
            />
            {error && (
              <p className="deck-error" role="alert">
                {error}
              </p>
            )}
            <div className="deck-sheet-actions">
              <button type="button" className="deck-secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="deck-primary"
                onClick={() => void send()}
                disabled={!text.trim() || sending}
              >
                {sending ? 'Sending…' : `Send to ${nameOf(to)}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// -- Editor -----------------------------------------------------------------

const SAMPLE = `# The first slide

A paragraph or two. Lists, images and quotes work:

- one thing
- another

---

# The second slide

> A quote someone said.

![a picture](/uploads/example.png)
`;

const handlesOf = (s: string) =>
  s
    .split(/[\s,]+/)
    .map(cleanHandle)
    .filter(Boolean);

function DeckEditor({
  routeBase,
  slug,
  host,
  onDone,
}: {
  routeBase: string;
  slug: string | null;
  host: Host;
  onDone: (slug: string | null) => void;
}) {
  const [loaded, setLoaded] = useState(slug === null);
  const [title, setTitle] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [presenters, setPresenters] = useState(slug ? '' : host.actor.preferredUsername);
  const [viewers, setViewers] = useState('');
  const [markdown, setMarkdown] = useState(slug ? '' : SAMPLE);
  const [servers, setServers] = useState<Array<{ id: string; name: string }>>([]);
  const [serverId, setServerId] = useState(host.selectedServer?.id ?? '');
  const [createdBy, setCreatedBy] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = {
    title: useId(),
    slug: useId(),
    srv: useId(),
    pre: useId(),
    view: useId(),
    md: useId(),
  };

  useEffect(() => {
    if (slug) {
      call<DeckPayload>(`${routeBase}/decks/${encodeURIComponent(slug)}`).then(
        (d) => {
          setTitle(d.title);
          setPresenters(d.presenters.map((p) => p.handle).join(', '));
          setViewers((d.viewers ?? []).map((p) => p.handle).join(', '));
          setMarkdown(d.markdown);
          setCreatedBy(d.createdBy.id);
          setLoaded(true);
        },
        (e: Error) => setError(e.message),
      );
    } else {
      call<Array<{ id: string; name: string }>>(`${apiBase(routeBase)}/servers`).then(
        (s) => {
          setServers(s);
          setServerId((cur) => cur || s[0]?.id || '');
        },
        () => {},
      );
    }
  }, [routeBase, slug]);

  const slides = useMemo(() => parseSlides(markdown), [markdown]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const body = {
        title,
        markdown,
        presenters: handlesOf(presenters),
        viewers: handlesOf(viewers),
      };
      const d = slug
        ? await call<DeckPayload>(`${routeBase}/decks/${encodeURIComponent(slug)}`, 'PUT', body)
        : await call<DeckPayload>(`${routeBase}/decks`, 'POST', {
            ...body,
            serverId,
            slug: newSlug || slugify(title),
          });
      onDone((d as { removed?: boolean }).removed ? null : d.slug);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!slug || !window.confirm('Delete this deck for everyone? This can’t be undone.')) return;
    try {
      await call(`${routeBase}/decks/${encodeURIComponent(slug)}`, 'DELETE');
      onDone(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!loaded) {
    return (
      <div className="deck-root">
        <p className={error ? 'deck-error' : 'deck-muted'}>{error ?? 'Loading…'}</p>
      </div>
    );
  }

  return (
    <div className="deck-root deck-editor">
      <header className="deck-bar">
        <button type="button" className="deck-back" onClick={() => onDone(slug)}>
          ‹
        </button>
        <h2 className="deck-bar-title">{slug ? 'Edit deck' : 'New deck'}</h2>
      </header>
      <div className="deck-form">
        <label htmlFor={ids.title} className="deck-field-label">
          Title
        </label>
        <input
          id={ids.title}
          className="deck-input"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            if (!slugTouched) setNewSlug(slugify(e.target.value));
          }}
        />
        {!slug && (
          <>
            <label htmlFor={ids.slug} className="deck-field-label">
              Link name <span className="deck-muted">(/deck/{newSlug || '…'})</span>
            </label>
            <input
              id={ids.slug}
              className="deck-input"
              value={newSlug}
              onChange={(e) => {
                setSlugTouched(true);
                setNewSlug(e.target.value.toLowerCase());
              }}
            />
            <label htmlFor={ids.srv} className="deck-field-label">
              Server
            </label>
            <select
              id={ids.srv}
              className="deck-input"
              value={serverId}
              onChange={(e) => setServerId(e.target.value)}
            >
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </>
        )}
        <label htmlFor={ids.pre} className="deck-field-label">
          Presenters <span className="deck-muted">(handles; they answer questions)</span>
        </label>
        <input
          id={ids.pre}
          className="deck-input"
          value={presenters}
          onChange={(e) => setPresenters(e.target.value)}
          placeholder="juniper, moth"
        />
        <label htmlFor={ids.view} className="deck-field-label">
          Viewers{' '}
          <span className="deck-muted">(only these people, you and the presenters see it)</span>
        </label>
        <input
          id={ids.view}
          className="deck-input"
          value={viewers}
          onChange={(e) => setViewers(e.target.value)}
          placeholder="handles, separated by commas"
        />
        <label htmlFor={ids.md} className="deck-field-label">
          Slides{' '}
          <span className="deck-muted">(Markdown; a line with only --- starts a new slide)</span>
        </label>
        <textarea
          id={ids.md}
          className="deck-textarea deck-md"
          rows={16}
          value={markdown}
          onChange={(e) => setMarkdown(e.target.value)}
        />
        <p className="deck-muted">
          {slides.length} slide{slides.length === 1 ? '' : 's'}
          {slides.length > 0 && `: ${slides.map(slideLabel).join(' · ')}`}
        </p>
        {error && (
          <p className="deck-error" role="alert">
            {error}
          </p>
        )}
        <div className="deck-sheet-actions">
          {slug && createdBy === host.actor.id && (
            <button type="button" className="deck-danger" onClick={() => void remove()}>
              Delete
            </button>
          )}
          <button type="button" className="deck-secondary" onClick={() => onDone(slug)}>
            Cancel
          </button>
          <button
            type="button"
            className="deck-primary"
            onClick={() => void save()}
            disabled={saving || !title.trim() || slides.length === 0 || (!slug && !serverId)}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
