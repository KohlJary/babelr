// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useState } from 'react';

/**
 * Cass's record: every entry dated, attributed and sourced, newest first,
 * grouped by day, filterable by kind; the Markdown export downloads as is.
 * Read-only; the vessel builds it (record.py).
 */

interface Entry {
  at: string;
  who: string;
  kind: string;
  title: string;
  detail: string;
  source: string;
}

interface DaySpend {
  day: string;
  sessions: number;
  minutes: number;
  cost_usd: number;
}

interface Record {
  generated_at: string;
  days: number;
  entries: Entry[];
  spend_by_day: DaySpend[];
  unavailable: string[];
  kinds: { [kind: string]: string };
  digest: string;
}

const RANGES = [7, 30, 90, 365];
const KIND_ICONS: { [kind: string]: string } = {
  plan: '🗺️',
  ask: '🙋',
  change: '🧩',
  code: '🛠️',
  world: '🌍',
  day: '🗓️',
};

const wrap = {
  padding: '1rem 1.5rem',
  overflowY: 'auto' as const,
  height: '100%',
  maxWidth: '60rem',
};
const muted = { opacity: 0.7, fontSize: '0.85em' };
const chip = (on: boolean) => ({
  border: '1px solid var(--border, #555)',
  borderRadius: 999,
  padding: '0.15rem 0.6rem',
  marginRight: 6,
  marginBottom: 6,
  cursor: 'pointer',
  background: on ? 'var(--accent, #4a6)' : 'transparent',
  color: 'inherit',
});

export function RecordSidebarSlot(props: { host: unknown }) {
  const host = props.host as { openView: (id: string) => void };
  return (
    <button
      type="button"
      className="sidebar-item add-channel"
      onClick={() => host.openView('record')}
    >
      📜 Cass’s record
    </button>
  );
}

function dayOf(at: string): string {
  return at ? at.slice(0, 10) : 'undated';
}

export function RecordView(props: { routeBase: string; onClose: () => void }) {
  const { routeBase, onClose } = props;
  const [days, setDays] = useState(30);
  const [record, setRecord] = useState<Record | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [off, setOff] = useState<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    setRecord(null);
    setError(null);
    fetch(`${routeBase}/record?days=${days}`, { credentials: 'include' })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as Record & { error?: string };
        if (!live) return;
        if (!res.ok) setError(body.error ?? `Error ${res.status}`);
        else setRecord(body);
      })
      .catch(() => live && setError('Couldn’t reach the record.'));
    return () => {
      live = false;
    };
  }, [routeBase, days]);

  const shown = useMemo(
    () => (record?.entries ?? []).filter((e) => !off.has(e.kind)),
    [record, off],
  );
  const byDay = useMemo(() => {
    const groups: [string, Entry[]][] = [];
    for (const e of shown) {
      const d = dayOf(e.at);
      const last = groups[groups.length - 1];
      if (last && last[0] === d) last[1].push(e);
      else groups.push([d, [e]]);
    }
    return groups;
  }, [shown]);

  const toggle = (kind: string) =>
    setOff((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });

  return (
    <section style={wrap}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>📜 Cass’s record</h2>
        <label>
          Last{' '}
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {RANGES.map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
        </label>
        <a href={`${routeBase}/record.md?days=${days}`} download>
          Download Markdown
        </a>
        <button type="button" onClick={onClose} style={{ marginLeft: 'auto' }}>
          Close
        </button>
      </div>
      <p style={muted}>
        What she planned, asked for, changed and did, for checking things work and following her
        progress. Every line says when, who acted, and where it came from. She can read it too.
      </p>

      {error && <p>{error}</p>}
      {!record && !error && <p>Reading the record…</p>}
      {record && (
        <>
          <div style={{ margin: '0.5rem 0' }}>
            {Object.entries(record.kinds).map(([kind, words]) => {
              const n = record.entries.filter((e) => e.kind === kind).length;
              return (
                <button
                  key={kind}
                  type="button"
                  style={chip(!off.has(kind))}
                  onClick={() => toggle(kind)}
                >
                  {KIND_ICONS[kind] ?? ''} {words} ({n})
                </button>
              );
            })}
          </div>
          {record.unavailable.length > 0 && (
            <p style={{ ...muted, color: 'var(--warning, #c90)' }}>
              Not included, couldn’t be read: {record.unavailable.join('; ')}
            </p>
          )}
          {byDay.length === 0 && <p>Nothing in this range.</p>}
          {byDay.map(([day, entries]) => (
            <div key={day} style={{ marginTop: '1rem' }}>
              <h3 style={{ marginBottom: '0.25rem' }}>{day}</h3>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {entries.map((e, i) => (
                  <li
                    key={`${e.source}:${i}`}
                    style={{ padding: '0.4rem 0', borderBottom: '1px solid var(--border, #333)' }}
                  >
                    <div>
                      <span style={muted}>{e.at.slice(11, 16)}</span> {KIND_ICONS[e.kind] ?? ''}{' '}
                      <strong>{e.who}</strong> · {e.title}
                    </div>
                    {e.detail && (
                      <div style={{ whiteSpace: 'pre-wrap', margin: '0.2rem 0 0 1.5rem' }}>
                        {e.detail}
                      </div>
                    )}
                    <div style={{ ...muted, marginLeft: '1.5rem' }}>source: {e.source}</div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {record.spend_by_day.length > 0 && (
            <>
              <h3 style={{ marginTop: '1.5rem' }}>Sessions and spend by day</h3>
              <table>
                <thead>
                  <tr>
                    <th align="left">Day</th>
                    <th align="right">Sessions</th>
                    <th align="right">Minutes</th>
                    <th align="right">Cost (USD)</th>
                  </tr>
                </thead>
                <tbody>
                  {record.spend_by_day.map((d) => (
                    <tr key={d.day}>
                      <td>{d.day}</td>
                      <td align="right">{d.sessions}</td>
                      <td align="right">{d.minutes}</td>
                      <td align="right">{d.cost_usd.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          <p style={muted}>
            Generated {record.generated_at}. Digest of these entries (sha256): {record.digest}
          </p>
        </>
      )}
    </section>
  );
}
