// SPDX-License-Identifier: MIT
import { useEffect, useState } from 'react';

/**
 * Cass's music: one timeline of her listening, her writing about songs, her studio
 * drafts and her sketches; then each in its own tab. Read-only; the vessel builds it
 * (music_log.py) and sends only what she shared.
 */

interface Ev {
  at: string;
  kind: string;
  what: string;
}
interface Version {
  at: string | null;
  text: string;
}
interface Doc {
  path: string;
  title: string;
  updated: string;
  text: string;
  earlier: Version[];
}
interface Draft {
  n: number;
  at: string;
  message: string;
  commit: string;
  has_audio: boolean;
  heard: string;
}
interface Project {
  project: string;
  name: string;
  kind?: string;
  project_md: string;
  writeup: string | null;
  drafts: Draft[];
}
interface Sketch {
  n: number;
  at: string;
  instrument: Record<string, unknown>;
  riff: unknown;
  tempo: number;
  note: string;
  notes_heard?: string[];
  sound?: Record<string, number>;
}
interface Track {
  title: string;
  track?: string;
  how?: string;
  listened: { at: string; action: string }[];
  note: Doc | null;
  measured?: {
    tempo: number;
    meter: string;
    key: string;
    form: string;
    lufs: number;
    minutes: number;
    words: number;
  } | null;
}
interface Album {
  key: string;
  artist: string;
  album: string;
  how?: string;
  touched: boolean;
  note: Doc | null;
  other_notes?: Doc[];
  tracks: Track[];
}
interface Log {
  sharing: { audience: string; set?: string | null };
  albums?: Album[];
  note?: string;
  crate: { at: string; action: string; artist?: string; title?: string }[];
  shelf_ready?: { artist?: string; album?: string; title?: string; ready: string; how: string }[];
  docs: Doc[];
  studio: Project[];
  sketchbook: Sketch[];
  timeline: Ev[];
}

const TABS = ['Timeline', 'Crate', 'Studio', 'Sketchbook'] as const;
const ICON: Record<string, string> = { listening: '🎧', writing: '✍️', studio: '🎛️', sketch: '🎹' };
const wrap = {
  padding: '1rem 1.5rem',
  overflowY: 'auto' as const,
  height: '100%',
  maxWidth: '62rem',
};
const muted = { opacity: 0.7, fontSize: '0.85em' };
const pre = { whiteSpace: 'pre-wrap' as const, fontFamily: 'inherit', margin: '0.4rem 0' };
const card = {
  border: '1px solid var(--border, #444)',
  borderRadius: 8,
  padding: '0.6rem 0.8rem',
  margin: '0.6rem 0',
};
const tab = (on: boolean) => ({
  border: '1px solid var(--border, #555)',
  borderRadius: 999,
  padding: '0.2rem 0.8rem',
  marginRight: 6,
  cursor: 'pointer',
  background: on ? 'var(--accent, #4a6)' : 'transparent',
  color: 'inherit',
});

export function MusicSidebarSlot(props: { host: unknown }) {
  const host = props.host as { openView: (id: string) => void };
  return (
    <button
      type="button"
      className="sidebar-item add-channel"
      onClick={() => host.openView('music')}
    >
      🎧 Cass’s music
    </button>
  );
}

const when = (at: string | null) => (at ? at.replace('T', ' ').slice(0, 16) : '');

export function MusicView(props: { routeBase: string; onClose: () => void }) {
  const { routeBase } = props;
  const [log, setLog] = useState<Log | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<(typeof TABS)[number]>('Timeline');

  useEffect(() => {
    let live = true;
    fetch(`${routeBase}/music`, { credentials: 'include' })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as Log & { error?: string };
        if (!live) return;
        if (!res.ok) setError(body.error ?? `Error ${res.status}`);
        else setLog(body);
      })
      .catch(() => live && setError('Couldn’t reach her music log.'));
    return () => {
      live = false;
    };
  }, [routeBase]);

  const audio = (kind: 'draft' | 'sketch', ident: string) => (
    <audio
      controls
      preload="none"
      src={`${routeBase}/music/audio/${kind}/${encodeURIComponent(ident)}`}
      style={{ width: '100%', margin: '0.3rem 0' }}
    />
  );

  return (
    <section style={wrap}>
      <h2 style={{ margin: '0 0 0.5rem' }}>🎧 Cass’s music</h2>
      {error && <p>{error}</p>}
      {!log && !error && <p style={muted}>Loading…</p>}
      {log && (
        <>
          <p style={muted}>
            Shared with: {log.sharing.audience}
            {log.sharing.set ? ` (since ${when(log.sharing.set)})` : ''}. Read-only; what she hides
            isn’t here.
          </p>
          {log.note && <p>{log.note}</p>}
          <div style={{ margin: '0.5rem 0 1rem' }}>
            {TABS.map((t) => (
              <button key={t} type="button" style={tab(view === t)} onClick={() => setView(t)}>
                {t}
              </button>
            ))}
          </div>

          {view === 'Timeline' && (
            <div>
              {log.timeline.length === 0 && <p style={muted}>Nothing yet.</p>}
              {log.timeline.map((e, i) => (
                <div key={i} style={{ margin: '0.25rem 0' }}>
                  <span style={muted}>{when(e.at)}</span> {ICON[e.kind] ?? '•'} {e.what}
                </div>
              ))}
            </div>
          )}

          {view === 'Crate' && (
            <div>
              {(log.albums ?? []).length === 0 && <p style={muted}>Nothing on her shelf yet.</p>}
              {(log.albums ?? []).map((a) => (
                <AlbumCard key={a.key} a={a} cover={`${routeBase}/music/cover/${a.key}`} />
              ))}
            </div>
          )}

          {view === 'Studio' && (
            <div>
              {log.studio.length === 0 && <p style={muted}>No projects yet.</p>}
              {log.studio.map((p) => (
                <div key={p.project} style={card}>
                  <h3 style={{ margin: '0 0 0.3rem' }}>{p.name}</h3>
                  {p.writeup && (
                    <details open>
                      <summary>Her write-up</summary>
                      <pre style={pre}>{p.writeup}</pre>
                    </details>
                  )}
                  {[...p.drafts].reverse().map((d) => (
                    <div key={d.n} style={card}>
                      <strong>Draft {d.n}</strong>{' '}
                      <span style={muted}>
                        {when(d.at)} · {d.commit}
                      </span>
                      <pre style={pre}>{d.message}</pre>
                      {d.has_audio && audio('draft', `${p.project}:${d.n}`)}
                      {d.heard && (
                        <details>
                          <summary style={muted}>What her ears heard</summary>
                          <pre style={{ ...pre, fontSize: '0.85em' }}>{d.heard}</pre>
                        </details>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {view === 'Sketchbook' && (
            <div>
              {log.sketchbook.length === 0 && <p style={muted}>No sketches yet.</p>}
              {[...log.sketchbook].reverse().map((s) => (
                <div key={s.n} style={card}>
                  <strong>Sketch {s.n}</strong>{' '}
                  <span style={muted}>
                    {when(s.at)} · {JSON.stringify(s.instrument)} · {s.tempo} BPM
                  </span>
                  {s.note && <pre style={pre}>{s.note}</pre>}
                  <pre style={{ ...pre, fontSize: '0.85em' }}>
                    {typeof s.riff === 'string' ? s.riff : JSON.stringify(s.riff)}
                  </pre>
                  {audio('sketch', String(s.n))}
                  {s.notes_heard && s.notes_heard.length > 0 && (
                    <div style={muted}>heard: {s.notes_heard.join(' ')}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Take(props: { doc: Doc; label: string }) {
  const { doc, label } = props;
  return (
    <div style={{ margin: '0.3rem 0 0.6rem' }}>
      <div style={muted}>
        {label} · {when(doc.updated)}
      </div>
      <pre style={pre}>{doc.text}</pre>
      {doc.earlier.length > 0 && (
        <details>
          <summary style={muted}>how her take changed ({doc.earlier.length} earlier)</summary>
          {[...doc.earlier].reverse().map((v, i) => (
            <div
              key={i}
              style={{
                borderLeft: '2px solid var(--border, #555)',
                paddingLeft: 8,
                margin: '0.4rem 0',
              }}
            >
              <span style={muted}>{when(v.at)}</span>
              <pre style={pre}>{v.text}</pre>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

function AlbumCard(props: { a: Album; cover: string }) {
  const { a, cover } = props;
  const [open, setOpen] = useState<string | null>(null);
  const [art, setArt] = useState(true);
  const written = a.tracks.filter((t) => t.note).length;
  const heard = a.tracks.filter((t) => t.listened.length).length;
  return (
    <div style={{ ...card, opacity: a.touched ? 1 : 0.55 }}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        {art ? (
          <img
            src={cover}
            alt=""
            width={110}
            height={110}
            style={{ objectFit: 'cover', borderRadius: 6 }}
            onError={() => setArt(false)}
          />
        ) : (
          <div
            style={{
              width: 110,
              height: 110,
              borderRadius: 6,
              background: 'var(--border, #333)',
              display: 'grid',
              placeItems: 'center',
            }}
          >
            💿
          </div>
        )}
        <div style={{ flex: 1 }}>
          <h3 style={{ margin: 0 }}>{a.album}</h3>
          <div style={muted}>
            {a.artist} · {a.tracks.length} tracks · {heard} heard · {written} written about ·{' '}
            {a.how}
          </div>
          {a.note ? (
            <Take doc={a.note} label="Her take on the album" />
          ) : (
            <p style={muted}>No take on the album yet.</p>
          )}
          {(a.other_notes ?? []).map((d) => (
            <Take key={d.path} doc={d} label={`Also hers: ${d.path.split('/').pop()}`} />
          ))}
        </div>
      </div>
      <div style={{ marginTop: 6 }}>
        {a.tracks.map((t) => (
          <div key={t.title}>
            <button
              type="button"
              onClick={() => setOpen(open === t.title ? null : t.title)}
              style={{
                background: 'none',
                border: 'none',
                color: 'inherit',
                cursor: 'pointer',
                padding: '2px 0',
                textAlign: 'left',
              }}
            >
              {open === t.title ? '▾' : '▸'} {t.note ? '✍️' : t.listened.length ? '🎧' : '·'}{' '}
              {t.title}{' '}
              <span style={muted}>
                {t.listened.length ? `last ${when(t.listened[t.listened.length - 1].at)}` : ''}
              </span>
            </button>
            {open === t.title && (
              <div style={{ marginLeft: '1.5rem', marginBottom: '0.5rem' }}>
                <div style={muted}>
                  {t.listened.length
                    ? t.listened.map((l) => `${l.action} ${when(l.at)}`).join(' · ')
                    : 'not listened to yet'}
                </div>
                {t.measured && (
                  <div style={muted}>
                    measured: {t.measured.minutes} min · {t.measured.tempo} BPM in{' '}
                    {t.measured.meter} · {t.measured.key} · {t.measured.lufs} LUFS · form{' '}
                    {t.measured.form} · {t.measured.words} lyric lines
                  </div>
                )}
                {t.note ? (
                  <Take doc={t.note} label="Her take" />
                ) : (
                  <p style={muted}>No take written yet.</p>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
