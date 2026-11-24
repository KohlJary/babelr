// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useRef, type CSSProperties } from 'react';

/**
 * The Daybook as a calendar (Kohl, 2026-11-24: "I was kind of thinking a
 * calendar view type thing not just a list of events").
 *
 * Week: the seven days ending on the chosen one (today on the right), an hour
 * grid, one column a day, one lane a daemon. A session is a block
 * as long as it ran ("· N min" in its title); everything else that day (a
 * journal, a dream, self-model shifts) is a chip, one per daemon per hour, so a
 * flood of a hundred observations is one chip. Today's column carries what's
 * coming up, dashed. Month: a grid of days with a bar per daemon. Times are the
 * records' own wall-clock times, read from the string, never re-zoned.
 */

export interface CalRow {
  at: string;
  kind: string;
  title: string;
  detail?: string;
  source?: string;
  daemon: string;
  label: string;
}
export interface CalUp {
  name: string;
  phase: string;
  starts_hour?: number | null;
  minutes?: number | null;
  daemon: string;
  label: string;
}

export const HOUR_PX = 34;
const MIN_BLOCK_PX = 18;

export const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const asDate = (d: string) => new Date(`${d}T12:00:00`);
export const addDays = (d: string, n: number) => {
  const x = asDate(d);
  x.setDate(x.getDate() + n);
  return isoDay(x);
};
/** Monday of the week holding `d`. */
export const weekStart = (d: string) => {
  const x = asDate(d);
  return addDays(d, -((x.getDay() + 6) % 7));
};
export const minuteOfDay = (at: string) => {
  const h = Number(at.slice(11, 13));
  const m = Number(at.slice(14, 16));
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : 0;
};
export const sessionMinutes = (r: { title: string }) =>
  Number(/([\d.]+) min/.exec(r.title)?.[1] ?? 0);

export type Placed =
  | { type: 'block'; top: number; height: number; lane: number; rows: CalRow[] }
  | { type: 'chip'; top: number; lane: number; rows: CalRow[] };

/** A day's rows placed on the grid: sessions as blocks, the rest as hourly chips. */
export function place(rows: CalRow[], lanes: string[]): Placed[] {
  const out: Placed[] = [];
  const chips = new Map<string, CalRow[]>();
  for (const r of rows) {
    const lane = Math.max(0, lanes.indexOf(r.daemon));
    const min = minuteOfDay(r.at);
    if (r.kind === 'sessions') {
      const len = sessionMinutes(r);
      out.push({
        type: 'block',
        top: (min / 60) * HOUR_PX,
        height: Math.max(MIN_BLOCK_PX, (len / 60) * HOUR_PX),
        lane,
        rows: [r],
      });
    } else {
      const k = `${lane}:${Math.floor(min / 60)}`;
      chips.set(k, [...(chips.get(k) ?? []), r]);
    }
  }
  for (const [k, rs] of chips) {
    const [lane] = k.split(':').map(Number);
    const first = Math.min(...rs.map((r) => minuteOfDay(r.at)));
    out.push({ type: 'chip', top: (first / 60) * HOUR_PX, lane, rows: rs });
  }
  return out;
}

/** "📓 🌙 🪞12": one icon per kind, with a count past one. */
export function chipLabel(rows: CalRow[], icons: Record<string, string>) {
  const n = new Map<string, number>();
  for (const r of rows) n.set(r.kind, (n.get(r.kind) ?? 0) + 1);
  return [...n].map(([k, c]) => `${icons[k] ?? '•'}${c > 1 ? c : ''}`).join(' ');
}

export const CAL_STYLE = `
.dbk-cal-bar{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.8rem}
.dbk-cal-bar .ttl{font-weight:700;margin-right:auto}
.dbk-nav{border:1px solid var(--dbk-line);background:transparent;color:inherit;border-radius:8px;padding:.25rem .6rem;cursor:pointer;font:inherit}
.dbk-nav:disabled{opacity:.35;cursor:default}
.dbk-wk{border:1px solid var(--dbk-line);border-radius:14px;overflow:hidden;background:var(--dbk-bg)}
.dbk-wk-head{position:sticky;top:0;z-index:6;min-width:max-content;display:grid;grid-template-columns:3rem repeat(7,minmax(6.5rem,1fr));border-bottom:1px solid var(--dbk-line);background:var(--dbk-card)}
.dbk-wk-head div{padding:.45rem .5rem;font-size:.8rem;color:var(--dbk-mute);white-space:nowrap}
.dbk-wk-head div[data-today=true]{color:var(--text-primary,#fff);font-weight:700}
.dbk-wk-head b{font-size:1.05rem;margin-left:.25rem;color:var(--text-primary,#fff)}
.dbk-wk-scroll{max-height:34rem;overflow:auto}
.dbk-wk-grid{min-width:max-content;display:grid;grid-template-columns:3rem repeat(7,minmax(6.5rem,1fr));position:relative}
.dbk-wk-hours{position:sticky;left:0;z-index:5;background:var(--dbk-bg)}
.dbk-wk-head>div:first-child{position:sticky;left:0;z-index:7;background:var(--dbk-card)}
.dbk-wk-hours div{height:${HOUR_PX}px;font-size:.7rem;color:var(--dbk-mute);text-align:right;padding-right:.35rem;transform:translateY(-.45rem)}
.dbk-wk-col{position:relative;border-left:1px solid var(--dbk-line);
  background:repeating-linear-gradient(to bottom,transparent 0,transparent ${HOUR_PX - 1}px,var(--dbk-line) ${HOUR_PX - 1}px,var(--dbk-line) ${HOUR_PX}px)}
.dbk-wk-col[data-today=true]{background-color:color-mix(in srgb,var(--h0,#f472b6) 6%,transparent)}
.dbk-wk-col[data-out=true]{opacity:.4}
.dbk-blk{position:absolute;border-radius:6px;padding:.15rem .3rem;font-size:.72rem;line-height:1.2;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;cursor:pointer;text-align:left;font-family:inherit;
  color:#111;background:color-mix(in srgb,var(--hue) 85%,transparent);border:1px solid var(--hue);box-shadow:0 2px 8px -4px var(--hue)}
.dbk-blk:hover,.dbk-chip:hover{filter:brightness(1.12);z-index:3}
.dbk-blk[aria-pressed=true],.dbk-chip[aria-pressed=true]{outline:2px solid var(--text-primary,#fff);z-index:4}
.dbk-chip{position:absolute;height:18px;border-radius:999px;padding:0 .4rem;font-size:.7rem;white-space:nowrap;cursor:pointer;font-family:inherit;z-index:2;
  color:var(--text-primary,#fff);background:var(--dbk-card);border:1px solid var(--hue);overflow:hidden;text-overflow:ellipsis}
.dbk-up-blk{position:absolute;border-radius:6px;padding:.15rem .3rem;font-size:.72rem;border:1px dashed var(--hue);color:var(--hue);background:transparent;overflow:hidden}
.dbk-now{position:absolute;left:0;right:0;height:2px;background:#ef4444;z-index:5}
.dbk-now::before{content:"";position:absolute;left:-4px;top:-3px;width:8px;height:8px;border-radius:50%;background:#ef4444}
.dbk-mo{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px}
.dbk-mo-h{font-size:.72rem;color:var(--dbk-mute);text-align:center;padding-bottom:.2rem}
.dbk-mo-d{min-height:5.2rem;border-radius:10px;background:var(--dbk-card);border:1px solid var(--dbk-line);padding:.35rem .4rem;text-align:left;cursor:pointer;color:inherit;font:inherit;display:flex;flex-direction:column;gap:.25rem}
.dbk-mo-d[data-other=true]{opacity:.35}
.dbk-mo-d[data-today=true]{border-color:var(--text-primary,#fff)}
.dbk-mo-d .n{font-size:.8rem;font-weight:700}
.dbk-mo-bar{height:6px;border-radius:3px;background:var(--hue)}
.dbk-mo-d .ic{font-size:.72rem;color:var(--dbk-mute);line-height:1.3}
.dbk-sel{margin-top:1rem;border:1px solid var(--dbk-line);border-radius:14px;padding:.9rem 1rem;background:var(--dbk-card)}
@media (max-width:640px){.dbk-mo-d{min-height:3.6rem}.dbk-mo-d .ic{display:none}}
`;

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function WeekView(props: {
  start: string;
  today: string;
  earliest: string;
  byDay: Map<string, CalRow[]>;
  lanes: string[];
  hue: Record<string, string>;
  icons: Record<string, string>;
  comingUp: CalUp[];
  selected: CalRow[] | null;
  onSelect: (rows: CalRow[]) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Open on the morning, not midnight, and on the latest day (a phone shows three).
    const s = scroller.current;
    if (s) {
      s.scrollTop = HOUR_PX * 6.5;
      s.scrollLeft = s.scrollWidth;
    }
  }, [props.start]);
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(props.start, i)),
    [props.start],
  );
  const n = Math.max(1, props.lanes.length);
  const laneStyle = (lane: number, inset = 2) => ({
    left: `calc(${(lane / n) * 100}% + ${inset}px)`,
    width: `calc(${100 / n}% - ${inset * 2}px)`,
  });
  const now = new Date();
  const nowTop = ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_PX;

  return (
    <div className="dbk-wk">
      <div className="dbk-wk-scroll" ref={scroller}>
        <div className="dbk-wk-head">
          <div />
          {days.map((d) => (
            <div key={d} data-today={d === props.today}>
              {DOW[(new Date(`${d}T12:00:00`).getDay() + 6) % 7]}
              <b>{Number(d.slice(8))}</b>
            </div>
          ))}
        </div>
        <div className="dbk-wk-grid" style={{ height: HOUR_PX * 24 }}>
          <div className="dbk-wk-hours">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h}>{h === 0 ? '' : `${h}:00`}</div>
            ))}
          </div>
          {days.map((d) => (
            <div
              key={d}
              className="dbk-wk-col"
              data-today={d === props.today}
              data-out={d > props.today || d < props.earliest}
            >
              {place(props.byDay.get(d) ?? [], props.lanes).map((p, i) => {
                const style = {
                  '--hue': props.hue[p.rows[0].daemon],
                  top: p.top,
                  ...(p.type === 'block'
                    ? { height: p.height, ...laneStyle(p.lane) }
                    : laneStyle(p.lane, 6)),
                } as unknown as CSSProperties;
                const pressed = !!props.selected && props.selected[0] === p.rows[0];
                const r = p.rows[0];
                return p.type === 'block' ? (
                  <button
                    key={i}
                    type="button"
                    className="dbk-blk"
                    style={style}
                    aria-pressed={pressed}
                    title={`${r.label} · ${r.at.slice(11, 16)} · ${r.title}`}
                    onClick={() => props.onSelect(p.rows)}
                  >
                    {r.title.replace(/\s*·\s*[\d.]+ min.*$/, '')}
                  </button>
                ) : (
                  <button
                    key={i}
                    type="button"
                    className="dbk-chip"
                    style={style}
                    aria-pressed={pressed}
                    title={`${r.label} · ${p.rows.length} at ${r.at.slice(11, 13)}:00`}
                    onClick={() => props.onSelect(p.rows)}
                  >
                    {chipLabel(p.rows, props.icons)}
                  </button>
                );
              })}
              {d === props.today &&
                props.comingUp
                  .filter((c) => c.starts_hour != null && c.starts_hour * 60 > now.getHours() * 60)
                  .map((c, i) => (
                    <div
                      key={`up${i}`}
                      className="dbk-up-blk"
                      title={`Coming up · ${c.label} · ${c.name}`}
                      style={
                        {
                          '--hue': props.hue[c.daemon],
                          top: (c.starts_hour as number) * HOUR_PX,
                          height: Math.max(MIN_BLOCK_PX, ((c.minutes ?? 30) / 60) * HOUR_PX),
                          ...laneStyle(Math.max(0, props.lanes.indexOf(c.daemon))),
                        } as CSSProperties
                      }
                    >
                      {c.name}
                    </div>
                  ))}
              {d === props.today && <div className="dbk-now" style={{ top: nowTop }} />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function MonthView(props: {
  anchor: string;
  today: string;
  earliest: string;
  byDay: Map<string, CalRow[]>;
  lanes: string[];
  labels: Record<string, string>;
  hue: Record<string, string>;
  icons: Record<string, string>;
  onPick: (day: string) => void;
}) {
  const month = props.anchor.slice(0, 7);
  const first = weekStart(`${month}-01`);
  const cells = Array.from({ length: 42 }, (_, i) => addDays(first, i));
  const weeks = cells[35].slice(0, 7) === month ? 6 : 5;
  const peak = Math.max(
    1,
    ...cells.flatMap((d) =>
      props.lanes.map((l) => (props.byDay.get(d) ?? []).filter((r) => r.daemon === l).length),
    ),
  );
  return (
    <div className="dbk-mo">
      {DOW.map((d) => (
        <div key={d} className="dbk-mo-h">
          {d}
        </div>
      ))}
      {cells.slice(0, weeks * 7).map((d) => {
        const rows = props.byDay.get(d) ?? [];
        const kinds = [...new Set(rows.map((r) => r.kind))];
        return (
          <button
            key={d}
            type="button"
            className="dbk-mo-d"
            data-other={d.slice(0, 7) !== month || d > props.today || d < props.earliest}
            data-today={d === props.today}
            onClick={() => props.onPick(d)}
            title={props.lanes
              .map((l) => `${props.labels[l] ?? l}: ${rows.filter((r) => r.daemon === l).length}`)
              .join(' · ')}
          >
            <span className="n">{Number(d.slice(8))}</span>
            {props.lanes.map((l) => {
              const c = rows.filter((r) => r.daemon === l).length;
              return c ? (
                <span
                  key={l}
                  className="dbk-mo-bar"
                  style={
                    {
                      '--hue': props.hue[l],
                      width: `${Math.max(12, Math.round((Math.log1p(c) / Math.log1p(peak)) * 100))}%`,
                    } as CSSProperties
                  }
                />
              ) : null;
            })}
            {kinds.length > 0 && (
              <span className="ic">{kinds.map((k) => props.icons[k] ?? '•').join(' ')}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
