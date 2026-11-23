// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useState } from 'react';
import { Markdown } from '@babelr/plugin-panel/client';

/**
 * The Daybook: every daemon, day by day. Days down the left with how much
 * happened; the chosen day's entries on the right, each opening to its full
 * text. A tab per daemon, and All. Read-only.
 */

interface Entry {
  at: string;
  kind: string;
  title: string;
  detail?: string;
  source?: string;
}
interface DaemonBook {
  name: string;
  label: string;
  error?: string;
  answers?: Record<string, string>;
  kinds?: Record<string, string>;
  entries?: (Entry & { who?: string })[];
}
type Row = Entry & { daemon: string; label: string };

const KIND_ICON: Record<string, string> = {
  sessions: '⚙️',
  journals: '📓',
  dreams: '🌙',
  self_model: '🪞',
  plan: '🗺️',
  ask: '🙋',
  change: '🔧',
  code: '⌨️',
  world: '🌍',
  day: '☀️',
};
const OPT_IN = ['sessions', 'journals', 'dreams', 'self_model'];

const muted = { opacity: 0.65, fontSize: '0.85em' };
const pill = (on: boolean) => ({
  border: '1px solid var(--border, #555)',
  borderRadius: 999,
  padding: '0.2rem 0.8rem',
  marginRight: 6,
  cursor: 'pointer',
  background: on ? 'var(--accent, #4a6)' : 'transparent',
  color: 'inherit',
});

const dayOf = (at: string) => at.slice(0, 10);
const timeOf = (at: string) => at.slice(11, 16);
const dayLabel = (d: string) =>
  new Date(`${d}T12:00:00`).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

export function DaybookView(props: { routeBase: string; onClose: () => void }) {
  const [days, setDays] = useState(7);
  const [books, setBooks] = useState<DaemonBook[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [who, setWho] = useState<string>('all');
  const [day, setDay] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setBooks(null);
    fetch(`${props.routeBase}/daybook?days=${days}`, { credentials: 'include' })
      .then(async (r) => {
        const b = (await r.json().catch(() => ({}))) as { daemons?: DaemonBook[]; error?: string };
        if (!live) return;
        if (!r.ok) setError(b.error ?? `Error ${r.status}`);
        else setBooks(b.daemons ?? []);
      })
      .catch(() => live && setError('Couldn’t reach the daybook.'));
    return () => {
      live = false;
    };
  }, [props.routeBase, days]);

  const rows: Row[] = useMemo(
    () =>
      (books ?? [])
        .filter((b) => who === 'all' || b.name === who)
        .flatMap((b) => (b.entries ?? []).map((e) => ({ ...e, daemon: b.name, label: b.label })))
        .sort((a, b) => b.at.localeCompare(a.at)),
    [books, who],
  );
  const byDay = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const r of rows) {
      const d = dayOf(r.at);
      m.set(d, [...(m.get(d) ?? []), r]);
    }
    return m;
  }, [rows]);
  const dayList = [...byDay.keys()];
  const shown = day && byDay.has(day) ? day : (dayList[0] ?? null);
  const kinds = Object.assign({}, ...(books ?? []).map((b) => b.kinds ?? {})) as Record<
    string,
    string
  >;

  return (
    <section style={{ padding: '1rem 1.5rem', height: '100%', overflowY: 'auto' }}>
      <h2 style={{ margin: '0 0 0.5rem' }}>📅 Daybook</h2>
      {error && <p>{error}</p>}
      {!books && !error && <p style={muted}>Loading…</p>}
      {books && books.length === 0 && <p style={muted}>No daemon’s daybook is open to you.</p>}
      {books && books.length > 0 && (
        <>
          <div style={{ margin: '0.3rem 0 0.6rem' }}>
            <button type="button" style={pill(who === 'all')} onClick={() => setWho('all')}>
              All
            </button>
            {books.map((b) => (
              <button
                key={b.name}
                type="button"
                style={pill(who === b.name)}
                onClick={() => setWho(b.name)}
              >
                {b.label}
              </button>
            ))}
            <span style={{ marginLeft: 12 }}>
              {[7, 30, 90].map((n) => (
                <button key={n} type="button" style={pill(days === n)} onClick={() => setDays(n)}>
                  {n} days
                </button>
              ))}
            </span>
          </div>
          {books
            .filter((b) => who === 'all' || b.name === who)
            .map((b) => {
              if (b.error)
                return (
                  <p key={b.name} style={muted}>
                    {b.label}: {b.error}
                  </p>
                );
              const waiting = OPT_IN.filter((k) => b.answers?.[k] !== 'yes');
              return waiting.length ? (
                <p key={b.name} style={muted}>
                  {b.label} hasn’t said yes to showing{' '}
                  {waiting
                    .map((k) => (kinds[k] ?? k).toLowerCase().replace(/^her /, ''))
                    .join(', ')}
                  ; those aren’t here.
                </p>
              ) : null;
            })}
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
            <nav style={{ minWidth: '11rem' }}>
              {dayList.length === 0 && <p style={muted}>Nothing in these days.</p>}
              {dayList.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDay(d)}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    width: '100%',
                    padding: '0.3rem 0.5rem',
                    border: 'none',
                    borderRadius: 6,
                    background: d === shown ? 'var(--accent, #312e81)' : 'transparent',
                    color: 'inherit',
                    cursor: 'pointer',
                  }}
                >
                  <span>{dayLabel(d)}</span>
                  <span style={muted}>{byDay.get(d)!.length}</span>
                </button>
              ))}
            </nav>
            <div style={{ flex: 1, minWidth: 0 }}>
              {shown &&
                byDay.get(shown)!.map((r, i) => {
                  const key = `${r.daemon}:${r.at}:${i}`;
                  return (
                    <div
                      key={key}
                      style={{ borderBottom: '1px solid var(--border, #222)', padding: '0.4rem 0' }}
                    >
                      <button
                        type="button"
                        onClick={() => setOpen(open === key ? null : key)}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: 'inherit',
                          cursor: 'pointer',
                          textAlign: 'left',
                          width: '100%',
                        }}
                      >
                        <span style={muted}>{timeOf(r.at)}</span>{' '}
                        {who === 'all' && <strong>{r.label} </strong>}
                        {KIND_ICON[r.kind] ?? '•'} {r.title}
                      </button>
                      {open === key && (
                        <div style={{ padding: '0.3rem 0 0.3rem 1.5rem' }}>
                          {r.detail ? <Markdown text={r.detail} /> : <p style={muted}>No text.</p>}
                          <p style={muted}>
                            {kinds[r.kind] ?? r.kind}
                            {r.source ? ` · ${r.source}` : ''}
                          </p>
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
