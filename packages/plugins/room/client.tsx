// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ListDetailView } from '../../client/src/components/ListDetailView.js';

/**
 * Cass's room: a gallery of what she shared (paintings with what she said
 * about each, music, writing, journal entries) and, for Kohl, her day plan,
 * agenda and homepage. Read-only; the vessel decides what each viewer sees.
 */

interface Piece {
  kind: 'painting' | 'music' | 'writing' | 'journal' | 'workspace';
  id: string;
  title: string | null;
  note: string;
  shared_at: string | null;
  created_at: string | null;
}

interface Overview {
  audience: 'kohl' | 'house' | null;
  sections: string[];
  pieces: Piece[];
  open: boolean;
}

interface Entry {
  key: string;
  label: string;
  meta: string;
  section?: string;
  piece?: Piece;
}

const SECTION_LABELS: Record<string, string> = {
  day_plan: '🗓️ Today’s plan',
  agenda: '🧵 Agenda',
  homepage: '🏠 Homepage',
};
const KIND_ICONS: Record<string, string> = {
  painting: '🎨',
  music: '🎵',
  writing: '✒️',
  journal: '📓',
  workspace: '📄',
};

const textStyle = { whiteSpace: 'pre-wrap' as const, lineHeight: 1.55, maxWidth: '46rem' };
const noteStyle = {
  borderLeft: '3px solid var(--accent, #888)',
  padding: '0.25rem 0.75rem',
  margin: '0.75rem 0',
  opacity: 0.9,
};

export function RoomSidebarSlot(props: { host: unknown }) {
  const host = props.host as { openView: (id: string) => void };
  return (
    <button
      type="button"
      className="sidebar-item add-channel"
      onClick={() => host.openView('room')}
    >
      🖼️ Cass’s room
    </button>
  );
}

function useJson<T>(url: string | null): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!url) return;
    let live = true;
    setData(null);
    setError(null);
    fetch(url, { credentials: 'include' })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!live) return;
        if (!res.ok) setError((body as { error?: string }).error ?? `Error ${res.status}`);
        else setData(body as T);
      })
      .catch(() => live && setError('Couldn’t reach the room.'));
    return () => {
      live = false;
    };
  }, [url]);
  return { data, error };
}

function piecePath(routeBase: string, p: Piece, file = false): string {
  const id = p.id.split('/').map(encodeURIComponent).join('/');
  return `${routeBase}/pieces/${p.kind}/${id}${file ? '/file' : ''}`;
}

function PieceDetail({ routeBase, piece }: { routeBase: string; piece: Piece }) {
  const { data, error } = useJson<Record<string, unknown>>(piecePath(routeBase, piece));
  if (error) return <p>{error}</p>;
  if (!data) return <p>Loading…</p>;
  const str = (k: string) => (typeof data[k] === 'string' ? (data[k] as string) : null);
  return (
    <article style={{ padding: '1rem 1.5rem' }}>
      <h2>{str('title') ?? 'Untitled'}</h2>
      {piece.note && <blockquote style={noteStyle}>{piece.note}</blockquote>}
      {piece.kind === 'painting' && (
        <>
          <img
            src={piecePath(routeBase, piece, true)}
            alt={str('subject') ?? str('title') ?? 'A painting by Cass'}
            style={{ maxWidth: '100%', maxHeight: '70vh', borderRadius: 6 }}
          />
          {str('why') && (
            <p>
              <strong>Why she painted it:</strong> {str('why')}
            </p>
          )}
          {str('artist_note') && (
            <p>
              <strong>What she saw in it:</strong> {str('artist_note')}
            </p>
          )}
        </>
      )}
      {piece.kind === 'music' && (
        <>
          {str('audio') && (
            <audio controls src={piecePath(routeBase, piece, true)} style={{ width: '100%' }} />
          )}
          {str('lyrics') && <div style={{ ...textStyle, marginTop: '1rem' }}>{str('lyrics')}</div>}
        </>
      )}
      {['writing', 'journal', 'workspace'].includes(piece.kind) && (
        <div style={textStyle}>{str('content')}</div>
      )}
    </article>
  );
}

interface HomepagePage {
  slug: string;
  title: string;
  html: string;
}
interface Homepage {
  tagline?: string | null;
  pages?: HomepagePage[];
  stylesheet?: string | null;
  featured?: { title?: string; type?: string; excerpt?: string }[];
  updated_at?: string | null;
}

// Her pages render in a frame that runs no scripts; it only shows her HTML
// and CSS, and loads images and songs from her room.
const FRAME_CSP =
  "default-src 'none'; img-src 'self' data: https:; media-src 'self'; " +
  "style-src 'unsafe-inline'; font-src 'self' data: https:";

/** One of her pages as a standalone document: her stylesheet inlined, her
 * assets/ paths pointed at the room, outside links opening a new tab. */
export function buildCard(html: string, stylesheet: string, assetBase: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, base, link, meta[http-equiv]').forEach((el) => el.remove());
  const csp = doc.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', FRAME_CSP);
  doc.head.prepend(csp);
  const style = doc.createElement('style');
  style.textContent = stylesheet;
  doc.head.append(style);
  doc.querySelectorAll('[src]').forEach((el) => {
    const src = el.getAttribute('src') ?? '';
    const m = /^(?:\.\/)?assets\/([^/?#]+)$/.exec(src);
    if (m) el.setAttribute('src', `${assetBase}/${encodeURIComponent(decodeURIComponent(m[1]))}`);
  });
  doc.querySelectorAll('a[href]').forEach((a) => {
    if (/^(https?:|mailto:)/i.test(a.getAttribute('href') ?? '')) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
  });
  return '<!doctype html>' + doc.documentElement.outerHTML;
}

/** Which of her pages an in-page link goes to ("about.html", "pages/about.html"), if any. */
export function cardFor(href: string, slugs: string[]): string | null {
  const m = /^(?:\.\/)?(?:pages\/)?([A-Za-z0-9_-]+)\.html(?:#.*)?$/.exec(href);
  if (!m) return null;
  return slugs.includes(m[1]) ? m[1] : null;
}

function HomepageCards({ routeBase, data }: { routeBase: string; data: Homepage }) {
  const pages = data.pages ?? [];
  const slugs = pages.map((p) => p.slug);
  const [slug, setSlug] = useState<string>(slugs[0] ?? 'index');
  const frame = useRef<HTMLIFrameElement>(null);
  const page = pages.find((p) => p.slug === slug) ?? pages[0];
  const srcDoc = useMemo(
    () =>
      page
        ? buildCard(page.html, data.stylesheet ?? '', `${routeBase}/sections/homepage/assets`)
        : '',
    [page, data.stylesheet, routeBase],
  );

  const onLoad = () => {
    const doc = frame.current?.contentDocument;
    if (!doc || !frame.current) return;
    frame.current.style.height = `${Math.max(320, doc.documentElement.scrollHeight + 8)}px`;
    doc.addEventListener('click', (ev) => {
      const a = (ev.target as Element | null)?.closest?.('a[href]');
      if (!a || a.getAttribute('target') === '_blank') return;
      ev.preventDefault();
      const next = cardFor(a.getAttribute('href') ?? '', slugs);
      if (next) setSlug(next);
    });
  };

  return (
    <>
      {data.tagline && <p style={{ fontStyle: 'italic' }}>{data.tagline}</p>}
      {pages.length > 1 && (
        <nav style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', margin: '0.5rem 0' }}>
          {pages.map((p) => (
            <button
              key={p.slug}
              type="button"
              onClick={() => setSlug(p.slug)}
              aria-pressed={p.slug === page?.slug}
              style={{
                padding: '0.2rem 0.7rem',
                borderRadius: 4,
                border: '1px solid var(--border, #555)',
                background: p.slug === page?.slug ? 'var(--accent, #555)' : 'transparent',
                color: 'inherit',
                cursor: 'pointer',
              }}
            >
              {p.slug === 'index' ? 'home' : p.title}
            </button>
          ))}
        </nav>
      )}
      {page ? (
        <iframe
          ref={frame}
          title={page.title}
          srcDoc={srcDoc}
          onLoad={onLoad}
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          style={{
            width: '100%',
            minHeight: 320,
            border: '1px solid var(--border, #444)',
            borderRadius: 6,
            background: '#fff',
          }}
        />
      ) : (
        <p>Her homepage has no pages yet.</p>
      )}
      {data.updated_at && (
        <p style={{ opacity: 0.6, fontSize: '0.85em' }}>
          Last changed {new Date(data.updated_at).toLocaleString()}
        </p>
      )}
    </>
  );
}

function SectionDetail({ routeBase, name }: { routeBase: string; name: string }) {
  const { data, error } = useJson<Record<string, unknown>>(`${routeBase}/sections/${name}`);
  if (error) return <p>{error}</p>;
  if (!data) return <p>Loading…</p>;
  let body: ReactNode;
  if (name === 'homepage') {
    body = data.exists ? (
      <HomepageCards routeBase={routeBase} data={data as unknown as Homepage} />
    ) : (
      <p>She hasn’t made her homepage yet.</p>
    );
  } else {
    body = data.text ? (
      <>
        <div style={textStyle}>{data.text as string}</div>
        {typeof data.updated_at === 'string' && (
          <p style={{ opacity: 0.6, fontSize: '0.85em' }}>
            Updated {new Date(data.updated_at).toLocaleString()}
          </p>
        )}
      </>
    ) : (
      <p>Nothing here yet.</p>
    );
  }
  return (
    <article style={{ padding: '1rem 1.5rem' }}>
      <h2>{SECTION_LABELS[name] ?? name}</h2>
      {body}
    </article>
  );
}

export function RoomView(props: { routeBase: string; onClose: () => void }) {
  const { routeBase, onClose } = props;
  const [overview, setOverview] = useState<Overview | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const res = await fetch(`${routeBase}/overview`, { credentials: 'include' });
    if (res.ok) setOverview((await res.json()) as Overview);
  }, [routeBase]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const entries: Entry[] = [
    ...(overview?.sections ?? []).map((s) => ({
      key: `section:${s}`,
      label: SECTION_LABELS[s] ?? s,
      meta: '',
      section: s,
    })),
    ...(overview?.pieces ?? []).map((p) => ({
      key: `${p.kind}:${p.id}`,
      label: `${KIND_ICONS[p.kind] ?? ''} ${p.title ?? 'Untitled'}`,
      meta: p.shared_at ? `shared ${new Date(p.shared_at).toLocaleDateString()}` : '',
      piece: p,
    })),
  ];

  const empty = !overview
    ? 'Opening her room…'
    : overview.open
      ? 'She hasn’t shared anything here yet.'
      : 'Her room isn’t open to you yet.';

  return (
    <ListDetailView<Entry>
      title="Cass’s room"
      items={entries}
      getId={(e) => e.key}
      getLabel={(e) => e.label}
      renderItem={(e) => (
        <span className="poll-list-row">
          <span className="poll-list-row-question">{e.label}</span>
          {e.meta && <span className="poll-list-row-meta">{e.meta}</span>}
        </span>
      )}
      selectedId={selected}
      onSelect={setSelected}
      onClose={onClose}
      searchPlaceholder="Search her room…"
      emptyListMessage={empty}
      renderDetail={(e) => {
        if (!e) {
          return (
            <div style={{ padding: '1.5rem', opacity: 0.8 }}>
              <p>What Cass chose to share. She decides what’s here, one piece at a time.</p>
            </div>
          );
        }
        if (e.section) return <SectionDetail routeBase={routeBase} name={e.section} />;
        return <PieceDetail routeBase={routeBase} piece={e.piece!} />;
      }}
    />
  );
}
