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
interface Log {
  sharing: { audience: string; set?: string | null };
  note?: string;
  crate: { at: string; action: string; artist?: string; title?: string }[];
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
              <h3>What she writes about songs</h3>
              {log.docs.length === 0 && <p style={muted}>Nothing written yet.</p>}
              {log.docs.map((d) => (
                <div key={d.path} style={card}>
                  <strong>{d.title}</strong>{' '}
                  <span style={muted}>
                    {d.path} · updated {when(d.updated)}
                  </span>
                  <pre style={pre}>{d.text}</pre>
                  {d.earlier.length > 0 && (
                    <details>
                      <summary style={muted}>{d.earlier.length} earlier version(s)</summary>
                      {[...d.earlier].reverse().map((v, i) => (
                        <div key={i} style={{ ...card, opacity: 0.85 }}>
                          <span style={muted}>{when(v.at)}</span>
                          <pre style={pre}>{v.text}</pre>
                        </div>
                      ))}
                    </details>
                  )}
                </div>
              ))}
              <h3>Listening</h3>
              {log.crate.length === 0 && <p style={muted}>No listening yet.</p>}
              {[...log.crate].reverse().map((c, i) => (
                <div key={i}>
                  <span style={muted}>{when(c.at)}</span> {c.action}: {c.artist} – {c.title}
                </div>
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
