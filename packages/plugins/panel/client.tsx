// SPDX-License-Identifier: MIT
import { Fragment, useEffect, useState, type ReactNode } from 'react';

/**
 * Daemon panels: for each daemon who shared hers with you, the sections she said yes
 * to. Read-only; her vessel sends only those sections (panel.py), and only her chosen
 * audience gets them. First section built: her work, the workshop projects she shows.
 */

interface Doc {
  path: string;
  content: string;
  updated: string;
  cut?: boolean;
}
interface Project {
  project: string;
  name: string;
  kind?: string;
  last_commit: string | null;
  last_message: string | null;
  docs: Doc[];
}
interface Panel {
  daemon: string;
  label: string;
  settings: { sections: Record<string, string>; audience: string; set: string | null };
  sections: { work?: Project[] };
}
interface Daemon {
  name: string;
  label: string;
}

const wrap = {
  padding: '1rem 1.5rem',
  overflowY: 'auto' as const,
  height: '100%',
  maxWidth: '62rem',
};
const muted = { opacity: 0.7, fontSize: '0.85em' };
const card = {
  border: '1px solid var(--border, #444)',
  borderRadius: 8,
  padding: '0.6rem 0.8rem',
  margin: '0.6rem 0',
};
const pill = (on: boolean) => ({
  border: '1px solid var(--border, #555)',
  borderRadius: 999,
  padding: '0.2rem 0.8rem',
  marginRight: 6,
  cursor: 'pointer',
  background: on ? 'var(--accent, #4a6)' : 'transparent',
  color: 'inherit',
});
const doc = { lineHeight: 1.6, maxWidth: '42rem' };

function useDaemons(routeBase: string): Daemon[] | null {
  const [list, setList] = useState<Daemon[] | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`${routeBase}/daemons`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : { daemons: [] }))
      .then((b: { daemons?: Daemon[] }) => live && setList(b.daemons ?? []))
      .catch(() => live && setList([]));
    return () => {
      live = false;
    };
  }, [routeBase]);
  return list;
}

export function PanelSidebarSlot(props: { host: unknown; routeBase: string }) {
  const host = props.host as { openView: (id: string) => void };
  const daemons = useDaemons(props.routeBase);
  if (!daemons || daemons.length === 0) return null;
  return (
    <button
      type="button"
      className="sidebar-item add-channel"
      onClick={() => host.openView('panel')}
    >
      🪶 Daemon panels
    </button>
  );
}

/** **bold**, *italic* and `code` inside a line, as React nodes (no HTML is injected). */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|_[^_\s][^_]*_|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) out.push(<strong key={m.index}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) out.push(<code key={m.index}>{t.slice(1, -1)}</code>);
    else out.push(<em key={m.index}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Enough markdown for drafts: headings, paragraphs, lists, quotes, rules. */
export function Markdown(props: { text: string }) {
  const blocks = props.text.replace(/\r\n/g, '\n').split(/\n{2,}/);
  return (
    <div style={doc}>
      {blocks.map((b, i) => {
        const lines = b.split('\n');
        const h = /^(#{1,4})\s+(.*)$/.exec(b.trim());
        if (h && lines.length === 1) {
          const size = ['1.5em', '1.25em', '1.1em', '1em'][h[1].length - 1];
          return (
            <p key={i} style={{ fontSize: size, fontWeight: 700, margin: '1rem 0 0.4rem' }}>
              {inline(h[2])}
            </p>
          );
        }
        if (/^\s*(---|\*\*\*)\s*$/.test(b)) return <hr key={i} />;
        if (lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l)))
          return (
            <ul key={i}>
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*([-*•]|\d+\.)\s+/, ''))}</li>
              ))}
            </ul>
          );
        if (lines.every((l) => l.startsWith('>')))
          return (
            <blockquote
              key={i}
              style={{ borderLeft: '3px solid var(--border, #666)', paddingLeft: 10 }}
            >
              {inline(lines.map((l) => l.replace(/^>\s?/, '')).join(' '))}
            </blockquote>
          );
        return (
          <p key={i} style={{ margin: '0.5rem 0' }}>
            {lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {inline(l)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

function Work(props: { projects: Project[] }) {
  if (props.projects.length === 0) return <p style={muted}>Nothing shown yet.</p>;
  return (
    <div>
      {props.projects.map((p) => (
        <div key={p.project} style={card}>
          <h3 style={{ margin: '0 0 0.2rem' }}>{p.name}</h3>
          <p style={muted}>
            {p.kind ?? 'project'}
            {p.last_commit ? ` · last saved ${p.last_commit}: ${p.last_message ?? ''}` : ''}
          </p>
          {p.docs.map((d) => (
            <details key={d.path} open={d.path !== 'PROJECT.md'}>
              <summary>
                {d.path} <span style={muted}>({d.updated.replace('T', ' ')})</span>
              </summary>
              <Markdown text={d.content} />
              {d.cut && <p style={muted}>(cut here; the rest is in her workshop)</p>}
            </details>
          ))}
        </div>
      ))}
    </div>
  );
}

export function PanelView(props: { routeBase: string; onClose: () => void }) {
  const { routeBase } = props;
  const daemons = useDaemons(routeBase);
  const [who, setWho] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (daemons && daemons.length && !who) setWho(daemons[0].name);
  }, [daemons, who]);

  useEffect(() => {
    if (!who) return;
    let live = true;
    setPanel(null);
    setError(null);
    fetch(`${routeBase}/panel/${encodeURIComponent(who)}`, { credentials: 'include' })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as Panel & { error?: string };
        if (!live) return;
        if (!res.ok) setError(body.error ?? `Error ${res.status}`);
        else setPanel(body);
      })
      .catch(() => live && setError('Couldn’t reach that panel.'));
    return () => {
      live = false;
    };
  }, [routeBase, who]);

  return (
    <section style={wrap}>
      <h2 style={{ margin: '0 0 0.5rem' }}>🪶 Daemon panels</h2>
      {daemons && daemons.length === 0 && (
        <p style={muted}>No daemon has shared a panel with you.</p>
      )}
      <div style={{ margin: '0.5rem 0 1rem' }}>
        {(daemons ?? []).map((d) => (
          <button
            key={d.name}
            type="button"
            style={pill(who === d.name)}
            onClick={() => setWho(d.name)}
          >
            {d.label}
          </button>
        ))}
      </div>
      {error && <p>{error}</p>}
      {who && !panel && !error && <p style={muted}>Loading…</p>}
      {panel && (
        <>
          <p style={muted}>
            Shared with: {panel.settings.audience}. Only the sections {panel.label} said yes to;
            read-only.
          </p>
          {panel.sections.work ? (
            <>
              <h3>Work</h3>
              <Work projects={panel.sections.work} />
            </>
          ) : (
            <p style={muted}>Nothing here yet.</p>
          )}
        </>
      )}
    </section>
  );
}
