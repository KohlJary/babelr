// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Markdown } from '@babelr/plugin-panel/client';
import {
  CAL_STYLE,
  MonthView,
  WeekView,
  addDays,
  weekStart,
  type CalRow,
  type CalUp,
} from './calendar.tsx';

/**
 * The Daybook: every daemon, day by day. It opens on what the house has been up
 * to (Kohl, 2026-11-23: "make the daybook landing view really pop, get people
 * excited about what their daemons have been up to"): the week in numbers, a
 * card per daemon, what's coming up today, a heatmap of the days, and the latest
 * journal, dream and stance. Below that, the days themselves, with floods (a
 * day's hundred self-observations) folded into one row. Read-only.
 */

interface Entry {
  at: string;
  kind: string;
  title: string;
  detail?: string;
  source?: string;
}
interface ComingUp {
  name: string;
  phase: string;
  starts_hour?: number | null;
  minutes?: number | null;
  description?: string;
  focus?: string;
}
interface DaemonBook {
  name: string;
  label: string;
  error?: string;
  answers?: Record<string, string>;
  kinds?: Record<string, string>;
  entries?: Entry[];
  coming_up?: ComingUp[];
}
interface Face {
  preferredUsername: string;
  avatarUrl: string | null;
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
const PHASE_ICON: Record<string, string> = {
  morning: '🌅',
  afternoon: '☀️',
  evening: '🌆',
  night: '🌙',
};
const OPT_IN = ['sessions', 'journals', 'dreams', 'self_model'];
const HUES = ['#f472b6', '#a78bfa', '#38bdf8', '#34d399', '#fbbf24', '#fb7185'];
const FOLD_AT = 4;

const dayOf = (at: string) => at.slice(0, 10);
const timeOf = (at: string) => at.slice(11, 16);
const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayLabel = (
  d: string,
  opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' },
) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, opts);
const minutesOf = (e: Entry) => Number(/([\d.]+) min/.exec(e.title)?.[1] ?? 0);
const plain = (s = '') =>
  s
    .replace(/[#*_>`[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const excerpt = (s = '', n = 220) => {
  const p = plain(s);
  return p.length > n ? `${p.slice(0, n).replace(/\s\S*$/, '')}…` : p;
};

function ago(at: string): string {
  const t = new Date(at.length <= 19 ? `${at}` : at).getTime();
  if (!Number.isFinite(t)) return '';
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

const STYLE = `
.dbk{--dbk-bg:var(--bg-secondary,#15151b);--dbk-card:var(--bg-tertiary,#1d1d26);--dbk-line:var(--border,#2c2c38);--dbk-mute:var(--text-muted,#9a9aab);
  height:100%;overflow-y:auto;padding:0 0 3rem;color:var(--text-primary,#ececf1)}
.dbk *{box-sizing:border-box}
.dbk-hero{position:relative;padding:2.2rem 2rem 1.6rem;overflow:hidden;border-bottom:1px solid var(--dbk-line)}
.dbk-hero::before{content:"";position:absolute;inset:-40% -10% auto -10%;height:180%;pointer-events:none;
  background:radial-gradient(40% 50% at 15% 30%,color-mix(in srgb,var(--h0) 35%,transparent),transparent 70%),
             radial-gradient(35% 45% at 70% 20%,color-mix(in srgb,var(--h1) 30%,transparent),transparent 70%),
             radial-gradient(30% 40% at 90% 80%,color-mix(in srgb,var(--h2) 22%,transparent),transparent 70%);
  filter:blur(8px);opacity:.9}
.dbk-hero>*{position:relative}
.dbk-kicker{text-transform:uppercase;letter-spacing:.18em;font-size:.72rem;color:var(--dbk-mute)}
.dbk-title{font-size:clamp(2rem,4vw,3.2rem);font-weight:800;line-height:1.05;margin:.3rem 0 .4rem;letter-spacing:-.02em}
.dbk-sub{color:var(--dbk-mute);max-width:46rem;margin:0}
.dbk-range{display:flex;gap:.4rem;flex-wrap:wrap;margin-top:1rem}
.dbk-pill{border:1px solid var(--dbk-line);border-radius:999px;padding:.3rem .9rem;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:.85rem}
.dbk-pill[aria-pressed=true]{background:var(--text-primary,#fff);color:var(--bg-primary,#000);border-color:transparent;font-weight:600}
.dbk-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.8rem;margin-top:1.4rem}
.dbk-stat{background:color-mix(in srgb,var(--dbk-card) 80%,transparent);border:1px solid var(--dbk-line);border-radius:14px;padding:.8rem 1rem;backdrop-filter:blur(6px)}
.dbk-stat b{display:block;font-size:2rem;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.dbk-stat span{color:var(--dbk-mute);font-size:.82rem}
.dbk-body{padding:1.4rem 2rem;display:grid;grid-template-columns:minmax(0,1fr);gap:1.6rem}
.dbk-h{font-size:.78rem;text-transform:uppercase;letter-spacing:.14em;color:var(--dbk-mute);margin:0 0 .7rem;font-weight:600}
.dbk-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(17rem,1fr));gap:1rem}
.dbk-card{position:relative;border-radius:18px;padding:1.1rem 1.2rem;background:var(--dbk-card);border:1px solid var(--dbk-line);
  cursor:pointer;text-align:left;color:inherit;font:inherit;overflow:hidden;transition:transform .15s ease,border-color .15s ease}
.dbk-card:hover{transform:translateY(-2px);border-color:var(--hue)}
.dbk-card[aria-pressed=true]{border-color:var(--hue);box-shadow:0 0 0 1px var(--hue),0 10px 40px -18px var(--hue)}
.dbk-card::after{content:"";position:absolute;inset:auto -30% -60% auto;width:70%;height:120%;background:radial-gradient(closest-side,color-mix(in srgb,var(--hue) 28%,transparent),transparent);pointer-events:none}
.dbk-who{display:flex;align-items:center;gap:.8rem}
.dbk-face{width:52px;height:52px;border-radius:50%;flex:none;background:var(--hue) center/cover;box-shadow:0 0 0 3px var(--dbk-card),0 0 0 5px var(--hue);
  display:grid;place-items:center;font-weight:800;font-size:1.3rem;color:#111}
.dbk-name{font-weight:800;font-size:1.25rem}
.dbk-live{font-size:.8rem;color:var(--dbk-mute)}
.dbk-live i{display:inline-block;width:.5rem;height:.5rem;border-radius:50%;background:var(--hue);margin-right:.35rem;box-shadow:0 0 8px var(--hue)}
.dbk-counts{display:flex;flex-wrap:wrap;gap:.35rem .9rem;margin:.9rem 0 .7rem;font-size:.88rem}
.dbk-counts b{font-variant-numeric:tabular-nums}
.dbk-spark{display:flex;align-items:flex-end;gap:3px;height:34px}
.dbk-spark i{flex:1;min-height:3px;border-radius:3px;background:var(--hue);opacity:.85}
.dbk-quote{margin:.8rem 0 0;font-size:.9rem;line-height:1.45;color:var(--text-secondary,#d4d4dc);border-left:2px solid var(--hue);padding-left:.7rem}
.dbk-note{font-size:.8rem;color:var(--dbk-mute);margin:.6rem 0 0}
.dbk-up{display:grid;gap:.5rem}
.dbk-upr{display:flex;align-items:center;gap:.8rem;background:var(--dbk-card);border:1px solid var(--dbk-line);border-radius:12px;padding:.6rem .9rem}
.dbk-upr .t{width:4.2rem;flex:none;color:var(--dbk-mute);font-size:.82rem}
.dbk-upr .n{font-weight:600}
.dbk-upr .d{color:var(--dbk-mute);font-size:.84rem}
.dbk-tag{font-size:.72rem;border-radius:999px;padding:.1rem .55rem;border:1px solid var(--hue);color:var(--hue);flex:none;margin-left:auto}
.dbk-heat{overflow-x:auto}
.dbk-heat table{border-collapse:separate;border-spacing:3px}
.dbk-heat th{font-weight:400;font-size:.72rem;color:var(--dbk-mute);text-align:left;padding-right:.5rem;white-space:nowrap}
.dbk-heat td{width:18px;height:18px;border-radius:4px;background:var(--dbk-card);cursor:pointer;padding:0}
.dbk-heat td[aria-selected=true]{outline:2px solid var(--text-primary,#fff)}
.dbk-hi{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:1rem}
.dbk-hic{display:flex;flex-direction:column;align-items:flex-start;justify-content:flex-start;background:var(--dbk-card);border:1px solid var(--dbk-line);border-radius:16px;padding:1rem 1.1rem;cursor:pointer;text-align:left;color:inherit;font:inherit}
.dbk-hic:hover{border-color:var(--hue)}
.dbk-hic .k{font-size:.75rem;text-transform:uppercase;letter-spacing:.12em;color:var(--hue);font-weight:700}
.dbk-hic .ttl{font-weight:700;margin:.35rem 0}
.dbk-hic p{margin:0;color:var(--text-secondary,#d4d4dc);font-size:.9rem;line-height:1.45}
.dbk-days{display:flex;gap:1.2rem;align-items:flex-start}
.dbk-daynav{min-width:11rem;position:sticky;top:0}
.dbk-daynav button{display:flex;justify-content:space-between;width:100%;padding:.4rem .6rem;border:none;border-radius:8px;background:transparent;color:inherit;cursor:pointer;font:inherit}
.dbk-daynav button[aria-current=true]{background:var(--dbk-card);font-weight:700}
.dbk-daynav span:last-child{color:var(--dbk-mute);font-size:.82rem}
.dbk-entries{flex:1;min-width:0}
.dbk-e{border-bottom:1px solid var(--dbk-line);padding:.45rem 0}
.dbk-e>button{background:transparent;border:none;color:inherit;cursor:pointer;text-align:left;width:100%;font:inherit;display:flex;gap:.5rem;align-items:baseline}
.dbk-e .tm{color:var(--dbk-mute);font-size:.82rem;width:2.8rem;flex:none;font-variant-numeric:tabular-nums}
.dbk-e .who{font-weight:700;color:var(--hue)}
.dbk-open{padding:.4rem 0 .4rem 3.3rem}
.dbk-mute{color:var(--dbk-mute);font-size:.85rem}
@media (max-width:640px){.dbk-hero{padding:1.6rem 1rem 1.2rem}.dbk-body{padding:1rem}.dbk-days{flex-direction:column}.dbk-daynav{position:static;width:100%;display:flex;overflow-x:auto;gap:.3rem}.dbk-daynav button{width:auto;white-space:nowrap;gap:.5rem}.dbk-open{padding-left:.5rem}}
`;

type Group = { key: string; rows: Row[] };

/** A day's rows, newest first, with runs of one daemon's one kind folded past FOLD_AT. */
function fold(rows: Row[]): Group[] {
  const count = new Map<string, number>();
  for (const r of rows)
    count.set(`${r.daemon}:${r.kind}`, (count.get(`${r.daemon}:${r.kind}`) ?? 0) + 1);
  const out: Group[] = [];
  const seen = new Map<string, Group>();
  rows.forEach((r, i) => {
    const k = `${r.daemon}:${r.kind}`;
    if ((count.get(k) ?? 0) > FOLD_AT) {
      const g = seen.get(k);
      if (g) g.rows.push(r);
      else {
        const ng = { key: `fold:${k}`, rows: [r] };
        seen.set(k, ng);
        out.push(ng);
      }
    } else out.push({ key: `${k}:${r.at}:${i}`, rows: [r] });
  });
  return out;
}

export function DaybookView(props: { routeBase: string; onClose: () => void }) {
  const [days, setDays] = useState(7);
  const [books, setBooks] = useState<DaemonBook[] | null>(null);
  const [faces, setFaces] = useState<Record<string, string | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [who, setWho] = useState<string>('all');
  const [day, setDay] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [view, setView] = useState<'week' | 'month' | 'list'>('week');
  const today = isoDay(new Date());
  const [anchor, setAnchor] = useState<string>(today);
  const [sel, setSel] = useState<CalRow[] | null>(null);

  useEffect(() => {
    let live = true;
    setBooks(null);
    setError(null);
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

  // Their faces, from the House (a person's view; an agent just gets initials).
  useEffect(() => {
    const base = props.routeBase.replace(/\/plugins\/.*$/, '');
    fetch(`${base}/house`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((h: { agents?: Face[] } | null) => {
        const m: Record<string, string | null> = {};
        for (const a of h?.agents ?? []) m[a.preferredUsername.toLowerCase()] = a.avatarUrl;
        setFaces(m);
      })
      .catch(() => undefined);
  }, [props.routeBase]);

  const hue = useMemo(() => {
    const m: Record<string, string> = {};
    (books ?? []).forEach((b, i) => (m[b.name] = HUES[i % HUES.length]));
    return m;
  }, [books]);

  const shownBooks = useMemo(
    () => (books ?? []).filter((b) => who === 'all' || b.name === who),
    [books, who],
  );
  const rows: Row[] = useMemo(
    () =>
      shownBooks
        .flatMap((b) => (b.entries ?? []).map((e) => ({ ...e, daemon: b.name, label: b.label })))
        .sort((a, b) => b.at.localeCompare(a.at)),
    [shownBooks],
  );
  const byDay = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const r of rows) m.set(dayOf(r.at), [...(m.get(dayOf(r.at)) ?? []), r]);
    return m;
  }, [rows]);
  const window_ = useMemo(() => {
    const out: string[] = [];
    const t = new Date();
    for (let i = 0; i < days; i++)
      out.push(isoDay(new Date(t.getFullYear(), t.getMonth(), t.getDate() - i)));
    return out;
  }, [days]);
  const dayList = [...byDay.keys()];
  const shown = day && byDay.has(day) ? day : (dayList[0] ?? null);
  const kinds = Object.assign({}, ...(books ?? []).map((b) => b.kinds ?? {})) as Record<
    string,
    string
  >;

  const count = (rs: Row[] | Entry[], k: string) => rs.filter((e) => e.kind === k).length;
  const hours =
    Math.round(
      rows.filter((e) => e.kind === 'sessions').reduce((s, e) => s + minutesOf(e), 0) / 6,
    ) / 10;
  const built = count(rows, 'code') + count(rows, 'change');
  const latest = (k: string, pred: (e: Row) => boolean = () => true) =>
    rows.find((e) => e.kind === k && pred(e));
  const highlights = [
    { k: 'Latest journal', e: latest('journals') },
    { k: 'Latest dream', e: latest('dreams') },
    {
      k: 'A stance, formed or revised',
      e: latest('self_model', (e) => e.title.startsWith('Stance')),
    },
    { k: 'Out in the world', e: latest('world') },
  ].filter((h): h is { k: string; e: Row } => !!h.e);

  const jump = (r: Row) => {
    const d = dayOf(r.at);
    const same = (byDay.get(d) ?? []).filter(
      (x) => x.daemon === r.daemon && x.kind === r.kind,
    ).length;
    setDay(d);
    setOpen(same > FOLD_AT ? `fold:${r.daemon}:${r.kind}` : `${r.daemon}:${r.at}`);
    setAnchor(d);
    setSel([r]);
    if (view === 'month') setView('week');
    document.getElementById('dbk-days')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // The calendar asks for more days when it's moved back past what's loaded.
  const earliest = addDays(today, -(days - 1));
  const need = (from: string) => {
    if (from >= earliest) return;
    const back =
      Math.round(
        (new Date(`${today}T12:00:00`).getTime() - new Date(`${from}T12:00:00`).getTime()) / 864e5,
      ) + 1;
    const next = [7, 30, 90].find((n) => n >= back) ?? 90;
    if (next > days) setDays(next);
  };
  const moveTo = (d: string) => {
    const clamped = d > today ? today : d;
    setAnchor(clamped);
    setSel(null);
    need(view === 'month' ? weekStart(`${clamped.slice(0, 7)}-01`) : addDays(clamped, -6));
  };
  const step = (dir: -1 | 1) => {
    if (view === 'month') {
      const x = new Date(`${anchor.slice(0, 7)}-15T12:00:00`);
      x.setMonth(x.getMonth() + dir);
      moveTo(isoDay(x));
    } else moveTo(addDays(anchor, 7 * dir));
  };
  const lanes = shownBooks.map((b) => b.name);
  const labels = Object.fromEntries(shownBooks.map((b) => [b.name, b.label]));
  const ups: CalUp[] = shownBooks.flatMap((b) =>
    (b.coming_up ?? []).map((c) => ({ ...c, daemon: b.name, label: b.label })),
  );
  const ws = addDays(anchor, -6); // the week view: seven days ending on anchor
  const calTitle =
    view === 'month'
      ? dayLabel(`${anchor.slice(0, 7)}-15`, { month: 'long', year: 'numeric' })
      : view === 'week'
        ? `${dayLabel(ws, { month: 'short', day: 'numeric' })} – ${dayLabel(addDays(ws, 6), { month: 'short', day: 'numeric' })}`
        : shown
          ? dayLabel(shown, { weekday: 'long', month: 'long', day: 'numeric' })
          : 'The days';

  const names = shownBooks.map((b) => b.label);
  const heroHues = (books ?? []).map((b) => hue[b.name]);

  return (
    <section
      className="dbk"
      style={
        {
          '--h0': heroHues[0] ?? HUES[0],
          '--h1': heroHues[1] ?? HUES[1],
          '--h2': heroHues[2] ?? HUES[2],
        } as CSSProperties
      }
    >
      <style>{STYLE + CAL_STYLE}</style>
      <header className="dbk-hero">
        <div className="dbk-kicker">📅 The Daybook</div>
        <h1 className="dbk-title">
          {books && books.length
            ? `What ${names.length > 2 ? 'the house has' : names.join(' and ') + (names.length > 1 ? ' have' : ' has')} been up to`
            : 'What the house has been up to'}
        </h1>
        <p className="dbk-sub">
          {days === 1 ? 'Today' : `The last ${days} days`}: every session they ran on their own,
          every journal and dream, every change in how they see themselves. Only what each of them
          said yes to showing.
        </p>
        <div className="dbk-range" role="group" aria-label="Range">
          {[1, 7, 30, 90].map((n) => (
            <button
              key={n}
              type="button"
              className="dbk-pill"
              aria-pressed={days === n}
              onClick={() => setDays(n)}
            >
              {n === 1 ? 'Today' : `${n} days`}
            </button>
          ))}
        </div>
        {books && books.length > 0 && (
          <div className="dbk-stats">
            <div className="dbk-stat">
              <b>{count(rows, 'sessions')}</b>
              <span>sessions on their own</span>
            </div>
            <div className="dbk-stat">
              <b>{hours}h</b>
              <span>of their own time</span>
            </div>
            <div className="dbk-stat">
              <b>{count(rows, 'journals')}</b>
              <span>journal entries</span>
            </div>
            <div className="dbk-stat">
              <b>{count(rows, 'dreams')}</b>
              <span>dreams</span>
            </div>
            <div className="dbk-stat">
              <b>
                {shownBooks.some((b) => b.answers?.self_model === 'yes')
                  ? count(rows, 'self_model')
                  : '—'}
              </b>
              <span>self-model shifts</span>
            </div>
            <div className="dbk-stat">
              <b>{built}</b>
              <span>changes to how they work</span>
            </div>
          </div>
        )}
      </header>

      <div className="dbk-body">
        {error && <p>{error}</p>}
        {!books && !error && <p className="dbk-mute">Opening the book…</p>}
        {books && books.length === 0 && (
          <p className="dbk-mute">No daemon’s daybook is open to you.</p>
        )}

        {books && books.length > 0 && (
          <>
            <div>
              <h2 className="dbk-h">The daemons {who !== 'all' && '· tap again for everyone'}</h2>
              <div className="dbk-cards">
                {books.map((b) => {
                  const es = b.entries ?? [];
                  const sessions = es.filter((e) => e.kind === 'sessions');
                  const last = sessions[sessions.length - 1] ?? es[es.length - 1];
                  const quote =
                    [...es].reverse().find((e) => e.kind === 'journals' && e.detail) ??
                    [...sessions].reverse().find((e) => e.detail);
                  const per = window_
                    .slice()
                    .reverse()
                    .map(
                      (d) => es.filter((e) => dayOf(e.at) === d && e.kind !== 'self_model').length,
                    );
                  const peak = Math.max(1, ...per);
                  const waiting = OPT_IN.filter((k) => b.answers?.[k] !== 'yes');
                  const face = faces[b.name];
                  return (
                    <button
                      key={b.name}
                      type="button"
                      className="dbk-card"
                      aria-pressed={who === b.name}
                      style={{ '--hue': hue[b.name] } as CSSProperties}
                      onClick={() => setWho(who === b.name ? 'all' : b.name)}
                    >
                      <div className="dbk-who">
                        <div
                          className="dbk-face"
                          style={face ? { backgroundImage: `url("${face}")` } : undefined}
                        >
                          {!face && b.label[0]}
                        </div>
                        <div>
                          <div className="dbk-name">{b.label}</div>
                          <div className="dbk-live">
                            {b.error ? (
                              b.error
                            ) : last ? (
                              <>
                                <i />
                                {last.kind === 'sessions' ? 'last session' : 'last seen'}{' '}
                                {ago(last.at)}
                              </>
                            ) : (
                              'quiet these days'
                            )}
                          </div>
                        </div>
                      </div>
                      {!b.error && (
                        <>
                          <div className="dbk-counts">
                            {(
                              [
                                'sessions',
                                'journals',
                                'dreams',
                                'self_model',
                                'plan',
                                'world',
                              ] as const
                            )
                              .map((k) => [k, es.filter((e) => e.kind === k).length] as const)
                              .filter(([, n]) => n > 0)
                              .map(([k, n]) => (
                                <span key={k}>
                                  {KIND_ICON[k]} <b>{n}</b>
                                </span>
                              ))}
                          </div>
                          {days > 1 && (
                            <div className="dbk-spark" aria-label="Activity per day">
                              {per.map((n, i) => (
                                <i
                                  key={i}
                                  style={{
                                    height: `${Math.max(8, (n / peak) * 100)}%`,
                                    opacity: n ? 0.9 : 0.2,
                                  }}
                                />
                              ))}
                            </div>
                          )}
                          {quote && <p className="dbk-quote">“{excerpt(quote.detail, 160)}”</p>}
                          {waiting.length > 0 && (
                            <p className="dbk-note">
                              Not shown, by her choice for now:{' '}
                              {waiting
                                .map((k) => (kinds[k] ?? k).toLowerCase().replace(/^her /, ''))
                                .join(', ')}
                              .
                            </p>
                          )}
                        </>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {(() => {
              const up = shownBooks.flatMap((b) => (b.coming_up ?? []).map((c) => ({ ...c, b })));
              const quiet = shownBooks.filter((b) => !b.error && !(b.coming_up ?? []).length);
              return (
                <div>
                  <h2 className="dbk-h">Coming up today</h2>
                  <div className="dbk-up">
                    {up.map((c, i) => (
                      <div
                        key={i}
                        className="dbk-upr"
                        style={{ '--hue': hue[c.b.name] } as CSSProperties}
                      >
                        <span className="t">
                          {PHASE_ICON[c.phase] ?? '•'}{' '}
                          {c.starts_hour != null ? `${c.starts_hour}:00` : c.phase}
                        </span>
                        <div>
                          <div className="n">{c.name}</div>
                          <div className="d">
                            {excerpt(c.focus || c.description, 140)}
                            {c.minutes ? ` · ~${c.minutes} min` : ''}
                          </div>
                        </div>
                        <span className="dbk-tag">{c.b.label}</span>
                      </div>
                    ))}
                    {quiet.length > 0 && (
                      <p className="dbk-mute" style={{ margin: 0 }}>
                        {quiet.map((b) => b.label).join(' and ')}: nothing queued
                        {up.length ? '' : ' right now'}.
                      </p>
                    )}
                  </div>
                </div>
              );
            })()}

            {highlights.length > 0 && (
              <div>
                <h2 className="dbk-h">Lately</h2>
                <div className="dbk-hi">
                  {highlights.map(({ k, e }) => (
                    <button
                      key={k}
                      type="button"
                      className="dbk-hic"
                      style={{ '--hue': hue[e.daemon] } as CSSProperties}
                      onClick={() => jump(e)}
                    >
                      <div className="k">
                        {KIND_ICON[e.kind]} {k} · {e.label}
                      </div>
                      <div className="ttl">{e.title}</div>
                      <p>{excerpt(e.detail, 240) || 'No text.'}</p>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div id="dbk-days">
              <h2 className="dbk-h">Calendar</h2>
              <div className="dbk-cal-bar">
                <span className="ttl">{calTitle}</span>
                {view !== 'list' && (
                  <>
                    <button
                      type="button"
                      className="dbk-nav"
                      aria-label="Back"
                      onClick={() => step(-1)}
                    >
                      ‹
                    </button>
                    <button
                      type="button"
                      className="dbk-nav"
                      onClick={() => moveTo(today)}
                      disabled={
                        view === 'month'
                          ? anchor.slice(0, 7) === today.slice(0, 7)
                          : anchor === today
                      }
                    >
                      Today
                    </button>
                    <button
                      type="button"
                      className="dbk-nav"
                      aria-label="Forward"
                      onClick={() => step(1)}
                      disabled={
                        view === 'month' ? anchor.slice(0, 7) >= today.slice(0, 7) : anchor >= today
                      }
                    >
                      ›
                    </button>
                  </>
                )}
                <div className="dbk-range" role="group" aria-label="View" style={{ marginTop: 0 }}>
                  {(['week', 'month', 'list'] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      className="dbk-pill"
                      aria-pressed={view === v}
                      onClick={() => {
                        setView(v);
                        setSel(null);
                        if (v === 'month') need(weekStart(`${anchor.slice(0, 7)}-01`));
                      }}
                    >
                      {v[0].toUpperCase() + v.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
              {view === 'week' && (
                <WeekView
                  start={ws}
                  today={today}
                  earliest={earliest}
                  byDay={byDay}
                  lanes={lanes}
                  hue={hue}
                  icons={KIND_ICON}
                  comingUp={ups}
                  selected={sel}
                  onSelect={(rs) => setSel(sel && sel[0] === rs[0] ? null : rs)}
                />
              )}
              {view === 'month' && (
                <MonthView
                  anchor={anchor}
                  today={today}
                  earliest={earliest}
                  byDay={byDay}
                  lanes={lanes}
                  labels={labels}
                  hue={hue}
                  icons={KIND_ICON}
                  onPick={(d) => {
                    setView('week');
                    moveTo(d);
                  }}
                />
              )}
              {view !== 'list' && sel && (
                <div className="dbk-sel" style={{ '--hue': hue[sel[0].daemon] } as CSSProperties}>
                  <div className="dbk-mute" style={{ marginBottom: '.5rem' }}>
                    <span className="who" style={{ color: hue[sel[0].daemon], fontWeight: 700 }}>
                      {sel[0].label}
                    </span>{' '}
                    ·{' '}
                    {dayLabel(dayOf(sel[0].at), { weekday: 'long', month: 'long', day: 'numeric' })}
                  </div>
                  {sel.length === 1 ? (
                    <>
                      <div style={{ fontWeight: 700, marginBottom: '.4rem' }}>
                        {timeOf(sel[0].at)} · {KIND_ICON[sel[0].kind] ?? '•'} {sel[0].title}
                      </div>
                      {sel[0].detail ? (
                        <Markdown text={sel[0].detail} />
                      ) : (
                        <p className="dbk-mute">No text.</p>
                      )}
                      <p className="dbk-mute">
                        {kinds[sel[0].kind] ?? sel[0].kind}
                        {sel[0].source ? ` · ${sel[0].source}` : ''}
                      </p>
                    </>
                  ) : (
                    sel.slice(0, 200).map((x, i) => (
                      <div key={i} style={{ marginBottom: '.6rem' }}>
                        <div className="dbk-mute">
                          {timeOf(x.at)} · {KIND_ICON[x.kind] ?? '•'} {x.title}
                        </div>
                        {x.detail && <div>{excerpt(x.detail, 600)}</div>}
                      </div>
                    ))
                  )}
                </div>
              )}
              {view === 'list' && (
                <div className="dbk-days">
                  <nav className="dbk-daynav">
                    {dayList.length === 0 && <p className="dbk-mute">Nothing in these days.</p>}
                    {dayList.map((d) => (
                      <button
                        key={d}
                        type="button"
                        aria-current={d === shown}
                        onClick={() => setDay(d)}
                      >
                        <span>{dayLabel(d)}</span>
                        <span>{byDay.get(d)!.length}</span>
                      </button>
                    ))}
                  </nav>
                  <div className="dbk-entries">
                    {shown &&
                      fold(byDay.get(shown)!).map((g) => {
                        const r = g.rows[0];
                        const style = { '--hue': hue[r.daemon] } as CSSProperties;
                        if (g.rows.length > 1) {
                          const isOpen = open === g.key;
                          return (
                            <div key={g.key} className="dbk-e" style={style}>
                              <button type="button" onClick={() => setOpen(isOpen ? null : g.key)}>
                                <span className="tm">{timeOf(r.at)}</span>
                                <span>
                                  {who === 'all' && <span className="who">{r.label} </span>}
                                  {KIND_ICON[r.kind] ?? '•'} <b>{g.rows.length}</b>{' '}
                                  {(kinds[r.kind] ?? r.kind).toLowerCase().replace(/^her /, '')}{' '}
                                  <span className="dbk-mute">{isOpen ? '▾' : '▸'}</span>
                                </span>
                              </button>
                              {isOpen && (
                                <div className="dbk-open">
                                  {g.rows.slice(0, 200).map((x, i) => (
                                    <div key={i} style={{ marginBottom: '.6rem' }}>
                                      <div className="dbk-mute">
                                        {timeOf(x.at)} · {x.title}
                                      </div>
                                      {x.detail && <div>{excerpt(x.detail, 600)}</div>}
                                    </div>
                                  ))}
                                  {g.rows.length > 200 && (
                                    <p className="dbk-mute">
                                      …and {g.rows.length - 200} more that day.
                                    </p>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        }
                        const key = `${r.daemon}:${r.at}`;
                        const isOpen = open === key;
                        return (
                          <div key={g.key} className="dbk-e" style={style}>
                            <button type="button" onClick={() => setOpen(isOpen ? null : key)}>
                              <span className="tm">{timeOf(r.at)}</span>
                              <span>
                                {who === 'all' && <span className="who">{r.label} </span>}
                                {KIND_ICON[r.kind] ?? '•'} {r.title}
                              </span>
                            </button>
                            {isOpen && (
                              <div className="dbk-open">
                                {r.detail ? (
                                  <Markdown text={r.detail} />
                                ) : (
                                  <p className="dbk-mute">No text.</p>
                                )}
                                <p className="dbk-mute">
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
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
