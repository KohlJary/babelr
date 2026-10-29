// SPDX-License-Identifier: MIT
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type {
  ItemKind,
  MapAct,
  MapNode,
  OnYou,
  OnYouEntry,
  PlanDetail,
  PlanEvent,
  PlanItem,
  PlanPhase,
  PlanSummary,
} from './manifest.js';

/**
 * The Plans view: every plan you can see down the side, one plan in
 * the middle (phases and their items), and its discussion and full
 * history on the right. Anyone in the server shapes a plan; the
 * server's owner (and anyone the plan names) approves a phase.
 */

const SURFACE = { 'x-plans-surface': 'plans-view' };

/** The item to open, scroll to and highlight when the plan page loads. */
const FocusItem = createContext<string | null>(null);
const KINDS: ItemKind[] = ['build', 'outreach', 'research', 'decision', 'ask'];

async function call<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'include',
    cache: 'no-store',
    headers: { ...SURFACE, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

function md(text: string): string {
  return DOMPurify.sanitize(
    marked.parse(text || '', { gfm: true, breaks: true, async: false }) as string,
  );
}

const PHASE_LABEL: Record<PlanPhase['status'], string> = {
  draft: 'Draft',
  proposed: 'Proposed',
  approved: 'Approved',
  done: 'Done',
  declined: 'Declined',
};

export function PlansView({
  routeBase,
  onClose,
  serverId,
  initialSlug,
}: {
  routeBase: string;
  onClose: () => void;
  serverId: string | null;
  initialSlug?: string | null;
}) {
  const [plans, setPlans] = useState<PlanSummary[] | null>(null);
  const [slug, setSlug] = useState<string | null>(initialSlug ?? null);
  const [plan, setPlan] = useState<PlanDetail | null>(null);
  const [events, setEvents] = useState<PlanEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Land on what's on Kohl unless a link named a plan: the filter is the point.
  const [onYou, setOnYou] = useState(!initialSlug);
  const [focus, setFocus] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    try {
      setPlans(await call<PlanSummary[]>(`${routeBase}/plans`));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [routeBase]);

  const loadPlan = useCallback(async () => {
    if (!slug) return;
    try {
      const [d, ev] = await Promise.all([
        call<PlanDetail>(`${routeBase}/plans/${slug}`),
        call<PlanEvent[]>(`${routeBase}/plans/${slug}/events`),
      ]);
      setPlan(d);
      setEvents(ev);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [routeBase, slug]);

  useEffect(() => {
    void loadList();
    const id = setInterval(() => void loadList(), 30_000);
    return () => clearInterval(id);
  }, [loadList]);

  useEffect(() => {
    void loadPlan();
    const id = setInterval(() => void loadPlan(), 15_000);
    return () => clearInterval(id);
  }, [loadPlan]);

  useEffect(() => {
    if (!slug && plans?.length) setSlug(plans[0].slug);
  }, [plans, slug]);

  /** Run an action; the server answers with the plan as it now stands. */
  const act = useCallback(
    async (url: string, method: string, body?: unknown) => {
      setError(null);
      try {
        const d = await call<PlanDetail | { ok: boolean }>(`${routeBase}${url}`, method, body);
        if ('phases' in d) setPlan(d);
        if (slug) setEvents(await call<PlanEvent[]>(`${routeBase}/plans/${slug}/events`));
        void loadList();
        return true;
      } catch (err) {
        setError((err as Error).message);
        return false;
      }
    },
    [routeBase, slug, loadList],
  );

  const awaitingMe = (plans ?? []).reduce((n, p) => n + p.awaitingMe, 0);

  return (
    <div className="plans-view">
      <header className="plans-bar">
        <button type="button" className="plans-secondary" onClick={onClose}>
          ← Back
        </button>
        <span className="plans-count">
          {plans === null
            ? 'Loading…'
            : awaitingMe
              ? `${awaitingMe} phase${awaitingMe === 1 ? '' : 's'} waiting on your yes`
              : 'Plans'}
        </span>
        <button type="button" className="plans-primary" onClick={() => setCreating(true)}>
          New plan
        </button>
      </header>
      {error && <div className="plans-error">{error}</div>}

      <div className="plans-layout">
        <nav className="plans-list" aria-label="Plans">
          <button
            type="button"
            className={`plans-list-item plans-onyou-tab${onYou ? ' plans-current' : ''}`}
            aria-current={onYou ? 'true' : undefined}
            onClick={() => {
              setOnYou(true);
              setCreating(false);
            }}
          >
            <span className="plans-list-title">On you</span>
            <span className="plans-list-meta">the next step on every path</span>
          </button>
          {plans?.length === 0 && <p className="plans-hint">No plans yet.</p>}
          <ul>
            {(plans ?? []).map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className={`plans-list-item${!onYou && p.slug === slug ? ' plans-current' : ''}`}
                  aria-current={!onYou && p.slug === slug ? 'true' : undefined}
                  onClick={() => {
                    setSlug(p.slug);
                    setCreating(false);
                    setOnYou(false);
                  }}
                >
                  <span className="plans-list-title">{p.title}</span>
                  <span className="plans-list-meta">
                    {p.status} · {p.phaseCounts.approved + p.phaseCounts.done}/
                    {Object.values(p.phaseCounts).reduce((a, b) => a + b, 0) -
                      p.phaseCounts.declined}{' '}
                    phases · {p.itemCounts.done}/{p.itemCounts.total} items
                  </span>
                  {p.awaitingMe > 0 && <span className="plans-badge-you">Needs your yes</span>}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <main className="plans-main">
          {creating ? (
            <NewPlan
              routeBase={routeBase}
              serverId={serverId}
              onCreated={(s) => {
                setCreating(false);
                setSlug(s);
                void loadList();
              }}
              onCancel={() => setCreating(false)}
            />
          ) : onYou ? (
            <OnYouView
              routeBase={routeBase}
              decides={plan?.decidesSends ?? false}
              onOpen={(s, itemId) => {
                setSlug(s);
                setFocus(itemId ?? null);
                setOnYou(false);
              }}
            />
          ) : plan ? (
            <FocusItem.Provider value={focus}>
              <PlanBody plan={plan} events={events} act={act} />
            </FocusItem.Provider>
          ) : (
            <p className="plans-hint">Pick a plan, or start one.</p>
          )}
        </main>

        {plan && !creating && !onYou && <History plan={plan} events={events} act={act} />}
      </div>
    </div>
  );
}

// ── on you: the next step on every path ───────────────────────────────

function OnYouView({
  routeBase,
  decides,
  onOpen,
}: {
  routeBase: string;
  decides: boolean;
  onOpen: (slug: string, itemId?: string) => void;
}) {
  const [data, setData] = useState<OnYou | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Each plan's history, for an outreach draft's approval line.
  const [events, setEvents] = useState<Record<string, PlanEvent[]>>({});
  const [mode, setMode] = useState<'map' | 'list'>('map');
  const [actId, setActId] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await call<OnYou>(`${routeBase}/on-you`);
      setData(d);
      setError(null);
      const slugs = [...new Set([...d.next, ...d.more, ...d.blocked].map((e) => e.planSlug))];
      const got = await Promise.all(
        slugs.map((s) => call<PlanEvent[]>(`${routeBase}/plans/${s}/events`).catch(() => [])),
      );
      setEvents(Object.fromEntries(slugs.map((s, i) => [s, got[i]])));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [routeBase]);

  /** The plan page's item controls, here: act, then read the list again. */
  const act = useCallback<Act>(
    async (url, method, body) => {
      setError(null);
      try {
        await call(`${routeBase}${url}`, method, body);
        await load();
        return true;
      } catch (err) {
        setError((err as Error).message);
        return false;
      }
    },
    [routeBase, load],
  );

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 15_000);
    return () => clearInterval(id);
  }, [load]);

  /** Kohl moves a ready item up or down: the whole ready order becomes Kohl's (pinned). */
  const move = async (from: number, to: number) => {
    if (!data) return;
    const ready = [...data.next, ...data.more];
    if (to < 0 || to >= ready.length) return;
    const [x] = ready.splice(from, 1);
    ready.splice(to, 0, x);
    try {
      for (const [i, e] of ready.entries()) {
        if (e.item.rank !== i + 1 || e.item.rankedBy !== 'kohl') {
          await call(`${routeBase}/items/${e.item.id}`, 'PATCH', { rank: i + 1 });
        }
      }
    } catch (err) {
      setError((err as Error).message);
    }
    void load();
  };
  const unpin = async (e: OnYouEntry) => {
    try {
      await call(`${routeBase}/items/${e.item.id}`, 'PATCH', { rank: null });
    } catch (err) {
      setError((err as Error).message);
    }
    void load();
  };

  if (!data) return <p className="plans-hint">{error ?? 'Loading…'}</p>;
  const nothing = !data.next.length && !data.phases.length;
  const showMap = mode === 'map' && data.acts.length > 0;
  // The act with the rank-1 step in it, unless one was picked.
  const shown =
    data.acts.find((a) => a.id === actId) ??
    data.acts.find((a) => Object.values(a.nodes).some((n) => n.next === 1)) ??
    data.acts[0];
  const onMap = new Set(data.acts.flatMap((a) => Object.keys(a.nodes)));
  const node: MapNode | undefined =
    shown &&
    (shown.nodes[picked ?? ''] ??
      Object.values(shown.nodes)
        .filter((n) => n.next)
        .sort((x, y) => (x.next ?? 0) - (y.next ?? 0))[0]);
  const entryOf = (n: MapNode): OnYouEntry =>
    [...data.next, ...data.more, ...data.blocked, ...data.stuck].find(
      (e) => e.item.id === n.item.id,
    ) ?? { ...n, unlocks: 0 };

  const row = (e: OnYouEntry, i?: number, openFirst = false) => (
    <li key={e.item.id} className="plans-onyou-row">
      <ItemRow
        plan={{ decidesSends: decides }}
        item={e.item}
        events={events[e.planSlug] ?? []}
        act={act}
        defaultOpen={openFirst}
        context={
          <div className="plans-onyou-where">
            in {e.planTitle}
            {e.phaseTitle ? ` · ${e.phaseTitle}` : ''} ·{' '}
            <button
              type="button"
              className="plans-link"
              onClick={() => onOpen(e.planSlug, e.item.id)}
            >
              open in plan
            </button>
          </div>
        }
      />
      <div className="plans-meta">
        {e.item.why && <>{e.item.why} · </>}
        {e.unlocks > 0 && <>unlocks {e.unlocks} · </>}
        {e.stale && <>stale draft · </>}
        {e.waitingOn && (
          <>
            waiting on{' '}
            {e.waitingOn.map((w) => `"${w.title}"${w.owner ? ` (@${w.owner})` : ''}`).join(', ')}
            {' · '}
          </>
        )}
        {e.stuckOn && <>stuck: "{e.stuckOn.title}" was declined · </>}
        {e.item.rankedBy === 'kohl'
          ? 'your order'
          : e.item.rankedBy
            ? `ranked by ${e.item.rankedBy}`
            : 'unranked'}
        {decides && i !== undefined && (
          <span className="plans-onyou-order">
            <button
              type="button"
              className="plans-link"
              aria-label="Move up"
              onClick={() => void move(i, i - 1)}
            >
              ↑
            </button>
            <button
              type="button"
              className="plans-link"
              aria-label="Move down"
              onClick={() => void move(i, i + 1)}
            >
              ↓
            </button>
            {e.item.rankedBy === 'kohl' && (
              <button type="button" className="plans-link" onClick={() => void unpin(e)}>
                let RoboKohl rank it
              </button>
            )}
          </span>
        )}
      </div>
    </li>
  );

  const phaseRow = (p: OnYou['phases'][number]) => (
    <li key={p.phase.id} className="plans-onyou-row">
      <button type="button" className="plans-onyou-open" onClick={() => onOpen(p.planSlug)}>
        <span className="plans-item-title">{p.phase.title}</span>
        <span className="plans-onyou-where">{p.planTitle}</span>
      </button>
    </li>
  );

  const fold = (label: string, xs: OnYouEntry[], offset?: number) =>
    xs.length > 0 && (
      <details className="plans-onyou-fold">
        <summary>
          {label} ({xs.length})
        </summary>
        <ul>{xs.map((e, k) => row(e, offset === undefined ? undefined : offset + k))}</ul>
      </details>
    );

  return (
    <article className="plans-plan plans-onyou">
      <div className="plans-plan-top">
        <h2>On you</h2>
        {data.acts.length > 0 && (
          <div className="plans-row">
            <button
              type="button"
              className={mode === 'map' ? 'plans-primary' : 'plans-secondary'}
              onClick={() => setMode('map')}
            >
              Map
            </button>
            <button
              type="button"
              className={mode === 'list' ? 'plans-primary' : 'plans-secondary'}
              onClick={() => setMode('list')}
            >
              List
            </button>
          </div>
        )}
      </div>
      {error && <div className="plans-error">{error}</div>}
      {data.phasesNext.length > 0 && (
        <section className="plans-phase">
          <h3>Phases waiting on your yes</h3>
          <ul>{data.phasesNext.map(phaseRow)}</ul>
          {data.phases.length > data.phasesNext.length && (
            <details className="plans-onyou-fold">
              <summary>{data.phases.length - data.phasesNext.length} more phases waiting</summary>
              <ul>
                {data.phases
                  .filter((p) => !data.phasesNext.some((q) => q.phase.id === p.phase.id))
                  .map(phaseRow)}
              </ul>
            </details>
          )}
        </section>
      )}
      {showMap && shown ? (
        <>
          <ActHeader
            acts={data.acts}
            act={shown}
            onPick={(id) => {
              setActId(id);
              setPicked(null);
            }}
          />
          <div className="plans-map-wrap">
            <ActMap act={shown} picked={node?.item.id ?? null} onPick={setPicked} />
            <aside className="plans-map-panel" aria-label="The step you picked">
              {node ? (
                <ul>{row(entryOf(node), undefined, true)}</ul>
              ) : (
                <p className="plans-hint">Pick a step on the map.</p>
              )}
            </aside>
          </div>
          {data.next.some((e) => !onMap.has(e.item.id)) && (
            <section className="plans-phase">
              <h3>Next, off the map</h3>
              <ul>{data.next.map((e, i) => (onMap.has(e.item.id) ? null : row(e, i, false)))}</ul>
            </section>
          )}
        </>
      ) : (
        <section className="plans-phase">
          <h3>Next</h3>
          {nothing ? (
            <p className="plans-hint">Nothing's waiting on you.</p>
          ) : (
            <ul>{data.next.map((e, i) => row(e, i, true))}</ul>
          )}
        </section>
      )}
      {fold('More on you', data.more, data.next.length)}
      {fold('Waiting on something first', data.blocked)}
      {fold('Stuck behind something declined', data.stuck)}
      {fold('In flight', data.inFlight)}
      {fold('Shipped this week', data.shipped)}
    </article>
  );
}

// ── the map: an act drawn bottom to top, its goal at the top ──────────

const GLYPH: Record<ItemKind, string> = {
  outreach: '✎',
  build: '⚒',
  research: '⌕',
  decision: '⚖',
  ask: '?',
};
const STATE_WORD: Record<MapNode['state'], string> = {
  done: 'done',
  lit: 'next',
  ready: 'ready, not in Next',
  waiting: "someone else's",
  locked: 'waiting on an earlier step',
  stuck: 'stuck behind something declined',
};
const ROW_H = 92;

export function ActHeader({
  acts,
  act,
  onPick,
}: {
  acts: MapAct[];
  act: MapAct;
  onPick: (id: string) => void;
}) {
  const ns = Object.values(act.nodes);
  const count = (st: MapNode['state']) => ns.filter((n) => n.state === st).length;
  const name = (a: MapAct) => a.boss.goal || a.boss.planTitle;
  return (
    <div className="plans-map-head">
      <strong>
        Act {acts.indexOf(act) + 1} · {name(act)}
      </strong>
      <span className="plans-meta">
        {count('done')} walked · {count('lit')} lit · {ns.length - count('done') - count('lit')}{' '}
        ahead
      </span>
      {acts.length > 1 && (
        <select value={act.id} onChange={(e) => onPick(e.target.value)} aria-label="Act">
          {acts.map((a, i) => (
            <option key={a.id} value={a.id}>
              Act {i + 1} · {name(a)}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

export function ActMap({
  act,
  picked,
  onPick,
}: {
  act: MapAct;
  picked: string | null;
  onPick: (id: string) => void;
}) {
  // Display rows top to bottom: the boss, then the act's rows from the top down.
  const levels = act.rows.length + 1;
  const height = levels * ROW_H;
  const pos = new Map<string, { x: number; y: number }>();
  act.rows.forEach((row, r) =>
    row.forEach((id, i) =>
      pos.set(id, { x: ((i + 1) / (row.length + 1)) * 100, y: (levels - 1 - r + 0.5) * ROW_H }),
    ),
  );
  const boss = { x: 50, y: 0.5 * ROW_H };
  const edges: { from: { x: number; y: number }; to: { x: number; y: number }; cls: string }[] = [];
  for (const [id, n] of Object.entries(act.nodes)) {
    for (const a of n.item.after) {
      const from = pos.get(a);
      const to = pos.get(id);
      if (!from || !to) continue;
      const up = act.nodes[a].state;
      edges.push({
        from,
        to,
        cls: up === 'done' ? 'walked' : n.state === 'stuck' ? 'broken' : 'ahead',
      });
    }
  }
  for (const t of act.tops) {
    const from = pos.get(t);
    if (from) edges.push({ from, to: boss, cls: 'ahead' });
  }

  return (
    <div className="plans-map" style={{ height: height + 24 }}>
      <svg
        className="plans-map-edges"
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {edges.map((e, k) => (
          <line
            key={k}
            x1={e.from.x}
            y1={e.from.y}
            x2={e.to.x}
            y2={e.to.y}
            className={`plans-edge plans-edge-${e.cls}`}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <div
        className="plans-node plans-node-boss"
        style={{ left: `${boss.x}%`, top: boss.y }}
        title={act.boss.planTitle}
      >
        <span className="plans-node-glyph">♛</span>
        <span className="plans-node-title">{act.boss.goal || act.boss.planTitle}</span>
      </div>
      {[...pos.entries()].map(([id, p]) => {
        const n = act.nodes[id];
        const tip =
          n.state === 'lit'
            ? n.item.why || 'next'
            : n.state === 'waiting'
              ? `@${n.item.owner ?? '?'}`
              : STATE_WORD[n.state];
        return (
          <button
            key={id}
            type="button"
            className={`plans-node plans-node-${n.state}${picked === id ? ' plans-node-picked' : ''}`}
            style={{ left: `${p.x}%`, top: p.y }}
            title={`${n.item.title} (${tip})`}
            aria-label={`${n.item.title}, ${STATE_WORD[n.state]}`}
            aria-pressed={picked === id}
            onClick={() => onPick(id)}
          >
            {n.next && <span className="plans-node-rank">{n.next}</span>}
            <span className="plans-node-glyph">
              {n.state === 'done' ? '✓' : n.state === 'stuck' ? '✕' : GLYPH[n.item.kind]}
            </span>
            <span className="plans-node-title">{n.item.title}</span>
          </button>
        );
      })}
    </div>
  );
}

// ── a new plan ────────────────────────────────────────────────────────

function NewPlan({
  routeBase,
  serverId,
  onCreated,
  onCancel,
}: {
  routeBase: string;
  serverId: string | null;
  onCreated: (slug: string) => void;
  onCancel: () => void;
}) {
  const [servers, setServers] = useState<{ id: string; name: string }[]>([]);
  const [server, setServer] = useState(serverId ?? '');
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [narrative, setNarrative] = useState('');
  const [needs, setNeeds] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const api = routeBase.replace(/\/plugins\/plans$/, '');
    void call<{ id: string; name: string }[]>(`${api}/servers`).then(
      (list) => {
        setServers(list);
        setServer((s) => s || list[0]?.id || '');
      },
      () => {},
    );
  }, [routeBase]);

  const create = async () => {
    setError(null);
    try {
      const d = await call<PlanDetail>(`${routeBase}/plans`, 'POST', {
        serverId: server,
        title,
        goal,
        narrative,
        needsYesFrom: needs
          .split(/[\s,]+/)
          .map((n) => n.replace(/^@/, '').trim())
          .filter(Boolean),
      });
      onCreated(d.slug);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section className="plans-form">
      <h2>New plan</h2>
      <label>
        Server
        <select value={server} onChange={(e) => setServer(e.target.value)}>
          {servers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        Goal
        <textarea rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} />
      </label>
      <label>
        Sequencing (why this order; markdown)
        <textarea rows={6} value={narrative} onChange={(e) => setNarrative(e.target.value)} />
      </label>
      <label>
        Also needs a yes from (usernames, e.g. cass if it concerns her)
        <input value={needs} onChange={(e) => setNeeds(e.target.value)} placeholder="cass" />
      </label>
      {error && <div className="plans-error">{error}</div>}
      <div className="plans-row">
        <button type="button" className="plans-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="plans-primary"
          disabled={!title.trim() || !server}
          onClick={() => void create()}
        >
          Create plan
        </button>
      </div>
    </section>
  );
}

// ── a plan ────────────────────────────────────────────────────────────

type Act = (url: string, method: string, body?: unknown) => Promise<boolean>;

function PlanBody({ plan, events, act }: { plan: PlanDetail; events: PlanEvent[]; act: Act }) {
  const [editing, setEditing] = useState(false);
  const [goal, setGoal] = useState(plan.goal);
  const [narrative, setNarrative] = useState(plan.narrative);
  const [newPhase, setNewPhase] = useState('');
  const loose = plan.items.filter((i) => !i.phaseId);

  useEffect(() => {
    if (!editing) {
      setGoal(plan.goal);
      setNarrative(plan.narrative);
    }
  }, [plan, editing]);

  return (
    <article className="plans-plan">
      <div className="plans-plan-top">
        <h2>{plan.title}</h2>
        <select
          aria-label="Plan status"
          value={plan.status}
          onChange={(e) => void act(`/plans/${plan.slug}`, 'PATCH', { status: e.target.value })}
        >
          {['draft', 'active', 'done', 'archived'].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <div className="plans-meta">
        by {plan.createdBy.name} · approves: {plan.approvers.join(', ') || 'the server owner'}
      </div>

      {editing ? (
        <section className="plans-form">
          <label>
            Goal
            <textarea rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} />
          </label>
          <label>
            Sequencing
            <textarea rows={8} value={narrative} onChange={(e) => setNarrative(e.target.value)} />
          </label>
          <div className="plans-row">
            <button type="button" className="plans-secondary" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="plans-primary"
              onClick={async () => {
                if (await act(`/plans/${plan.slug}`, 'PATCH', { goal, narrative }))
                  setEditing(false);
              }}
            >
              Save
            </button>
          </div>
        </section>
      ) : (
        <section className="plans-goal">
          {plan.goal && <p className="plans-goal-text">{plan.goal}</p>}
          {plan.narrative && (
            <div className="plans-md" dangerouslySetInnerHTML={{ __html: md(plan.narrative) }} />
          )}
          <button type="button" className="plans-link" onClick={() => setEditing(true)}>
            Edit goal and sequencing
          </button>
        </section>
      )}

      {plan.phases.map((f) => (
        <PhaseCard
          key={f.id}
          plan={plan}
          phase={f}
          items={plan.items.filter((i) => i.phaseId === f.id)}
          events={events}
          act={act}
        />
      ))}

      {loose.length > 0 && (
        <section className="plans-phase">
          <h3>Not in a phase</h3>
          {loose.map((i) => (
            <ItemRow key={i.id} plan={plan} item={i} events={events} act={act} />
          ))}
        </section>
      )}

      <div className="plans-row plans-add">
        <input
          placeholder="New phase title"
          value={newPhase}
          onChange={(e) => setNewPhase(e.target.value)}
        />
        <button
          type="button"
          className="plans-secondary"
          disabled={!newPhase.trim()}
          onClick={async () => {
            if (await act(`/plans/${plan.slug}/phases`, 'POST', { title: newPhase }))
              setNewPhase('');
          }}
        >
          Add phase
        </button>
      </div>
    </article>
  );
}

function PhaseCard({
  plan,
  phase,
  items,
  events,
  act,
}: {
  plan: PlanDetail;
  phase: PlanPhase;
  items: PlanItem[];
  events: PlanEvent[];
  act: Act;
}) {
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<ItemKind>('build');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [owner, setOwner] = useState('');
  const youSaid = !phase.awaiting.some((n) => n.toLowerCase() === plan.you.toLowerCase());
  const canSay = plan.canApprove && phase.status === 'proposed';

  return (
    <section className={`plans-phase plans-phase-${phase.status}`}>
      <div className="plans-phase-top">
        <h3>
          <span className="plans-phase-n">Phase {phase.position + 1}</span> {phase.title}
        </h3>
        <span className={`plans-chip plans-chip-${phase.status}`}>{PHASE_LABEL[phase.status]}</span>
      </div>
      {phase.goal && <p className="plans-phase-goal">{phase.goal}</p>}
      {phase.holdingPen && (
        <div className="plans-meta">
          A holding pen, not a step: each draft here gets its own yes. Open one to approve it.
        </div>
      )}
      {phase.status === 'proposed' && !phase.holdingPen && (
        <div className="plans-meta">
          {phase.approvals.length > 0 &&
            `Yes from ${phase.approvals.map((a) => a.name).join(', ')}. `}
          Waiting on {phase.awaiting.join(', ') || 'nobody'}.
        </div>
      )}
      {phase.status === 'declined' && phase.declineReason && (
        <div className="plans-declined">Declined: {phase.declineReason}</div>
      )}

      {items.map((i) => (
        <ItemRow key={i.id} plan={plan} item={i} events={events} act={act} />
      ))}

      {adding ? (
        <div className="plans-form plans-item-form">
          <div className="plans-row">
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as ItemKind)}
              aria-label="Kind"
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
            <input
              placeholder="Owner (username)"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
            />
          </div>
          <textarea
            rows={3}
            placeholder="Details (markdown)"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          {phase.status === 'approved' && (
            <div className="plans-warn">
              This phase is approved; adding an item sends it back for approval.
            </div>
          )}
          <div className="plans-row">
            <button type="button" className="plans-secondary" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="plans-primary"
              disabled={!title.trim()}
              onClick={async () => {
                const ok = await act(`/plans/${plan.slug}/items`, 'POST', {
                  phaseId: phase.id,
                  kind,
                  title,
                  body,
                  owner: owner.replace(/^@/, '') || undefined,
                });
                if (ok) {
                  setAdding(false);
                  setTitle('');
                  setBody('');
                  setOwner('');
                }
              }}
            >
              Add item
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="plans-link" onClick={() => setAdding(true)}>
          + Add item
        </button>
      )}

      {declining && (
        <div className="plans-form">
          <textarea
            rows={2}
            placeholder="Why not? (required)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="plans-row">
            <button type="button" className="plans-secondary" onClick={() => setDeclining(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="plans-danger"
              disabled={!reason.trim()}
              onClick={async () => {
                if (await act(`/phases/${phase.id}/decline`, 'POST', { reason })) {
                  setDeclining(false);
                  setReason('');
                }
              }}
            >
              Decline phase
            </button>
          </div>
        </div>
      )}

      <div className="plans-row plans-phase-actions" hidden={phase.holdingPen}>
        {(phase.status === 'draft' || phase.status === 'declined') && (
          <button
            type="button"
            className="plans-secondary"
            onClick={() => void act(`/phases/${phase.id}/propose`, 'POST')}
          >
            Propose for approval
          </button>
        )}
        {canSay && !youSaid && (
          <>
            <button
              type="button"
              className="plans-approve"
              onClick={() => void act(`/phases/${phase.id}/approve`, 'POST')}
            >
              Approve phase
            </button>
            <button type="button" className="plans-danger" onClick={() => setDeclining(true)}>
              Decline
            </button>
          </>
        )}
        {phase.status === 'approved' && (
          <button
            type="button"
            className="plans-secondary"
            onClick={() => void act(`/phases/${phase.id}/done`, 'POST', {})}
          >
            Mark phase done
          </button>
        )}
      </div>
    </section>
  );
}

function ItemRow({
  plan,
  item,
  events,
  act,
  defaultOpen = false,
  context,
}: {
  plan: Pick<PlanDetail, 'decidesSends'>;
  item: PlanItem;
  events: PlanEvent[];
  act: Act;
  defaultOpen?: boolean;
  /** Where it lives, when shown outside its plan (On you). */
  context?: ReactNode;
}) {
  const focus = useContext(FocusItem);
  const focused = focus === item.id;
  const [open, setOpen] = useState(defaultOpen || focused);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focused) return;
    setOpen(true);
    ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focused]);
  const [finishing, setFinishing] = useState(false);
  const [resolution, setResolution] = useState('');
  const o = item.outreach;
  return (
    <div
      ref={ref}
      className={`plans-item plans-item-${item.status}${focused ? ' plans-item-focus' : ''}`}
    >
      <button
        type="button"
        className="plans-item-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className={`plans-kind plans-kind-${item.kind}`}>{item.kind}</span>
        <span className="plans-item-title">{item.title}</span>
        {item.owner && <span className="plans-item-owner">@{item.owner}</span>}
        <span className="plans-item-status">
          {o ? SEND_LABEL[o.sendStatus] : item.status.replace('_', ' ')}
        </span>
      </button>
      {open && (
        <div className="plans-item-body">
          {o ? (
            <SendPanel plan={plan} item={item} outreach={o} events={events} act={act} />
          ) : (
            item.body && (
              <div className="plans-md" dangerouslySetInnerHTML={{ __html: md(item.body) }} />
            )
          )}
          {item.resolution && (
            <div className="plans-resolution">
              <strong>Resolution:</strong> {item.resolution}
            </div>
          )}
          {context}
          <div className="plans-meta">added by {item.createdBy.name}</div>
          {o ? null : finishing ? (
            <div className="plans-form">
              <textarea
                rows={2}
                placeholder="What shipped (commits, links)"
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
              />
              <div className="plans-row">
                <button
                  type="button"
                  className="plans-secondary"
                  onClick={() => setFinishing(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="plans-primary"
                  disabled={!resolution.trim()}
                  onClick={async () => {
                    if (
                      await act(`/items/${item.id}/status`, 'POST', { status: 'done', resolution })
                    ) {
                      setFinishing(false);
                    }
                  }}
                >
                  Done
                </button>
              </div>
            </div>
          ) : (
            <div className="plans-row">
              {item.status === 'open' && (
                <button
                  type="button"
                  className="plans-secondary"
                  onClick={() =>
                    void act(`/items/${item.id}/status`, 'POST', { status: 'in_progress' })
                  }
                >
                  Start
                </button>
              )}
              {(item.status === 'open' || item.status === 'in_progress') && (
                <>
                  <button
                    type="button"
                    className="plans-secondary"
                    onClick={() => setFinishing(true)}
                  >
                    Mark done
                  </button>
                  <button
                    type="button"
                    className="plans-secondary"
                    onClick={() =>
                      void act(`/items/${item.id}/status`, 'POST', { status: 'declined' })
                    }
                  >
                    Decline
                  </button>
                </>
              )}
              {(item.status === 'done' || item.status === 'declined') && (
                <button
                  type="button"
                  className="plans-secondary"
                  onClick={() => void act(`/items/${item.id}/status`, 'POST', { status: 'open' })}
                >
                  Reopen
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── outreach: Kohl's yes on one draft ─────────────────────────────────

const SEND_LABEL: Record<NonNullable<PlanItem['outreach']>['sendStatus'], string> = {
  pending: 'waiting on Kohl',
  edited: 'edited, waiting on Kohl',
  approved: 'approved to send',
  vetoed: 'vetoed',
  sent: 'sent',
};

/** Where an outreach draft's approval stands, in words. */
function approvalLine(o: NonNullable<PlanItem['outreach']>, mine: PlanEvent[]): string {
  if (o.sendStatus === 'sent') return `rev ${o.rev}, sent`;
  if (o.sendStatus === 'vetoed') return `rev ${o.rev}, vetoed`;
  if (o.approvedRev === o.rev) return `rev ${o.rev}, approved to send`;
  const last = [...mine].reverse().find((e) => e.action === 'send-approve');
  if (last && Number(last.detail.rev) !== o.rev) {
    return `rev ${o.rev}, not approved; rev ${String(last.detail.rev)} was, before it changed`;
  }
  if (mine.some((e) => e.action === 'history-approved')) {
    return `rev ${o.rev}, not approved here; the queue's approval didn't carry over`;
  }
  return `rev ${o.rev}, not approved`;
}

function SendPanel({
  plan,
  item,
  outreach: o,
  events,
  act,
}: {
  plan: Pick<PlanDetail, 'decidesSends'>;
  item: PlanItem;
  outreach: NonNullable<PlanItem['outreach']>;
  events: PlanEvent[];
  act: Act;
}) {
  const [mode, setMode] = useState<null | 'hold' | 'veto' | 'sent'>(null);
  const [note, setNote] = useState('');
  const mine = events.filter((e) => e.itemId === item.id);
  const lastDecision = [...mine].reverse().find((e) => e.action.startsWith('send-'));
  const send = async (body: Record<string, unknown>) => {
    if (await act(`/items/${item.id}/send`, 'POST', body)) {
      setMode(null);
      setNote('');
    }
  };
  const done = o.sendStatus === 'sent' || o.sendStatus === 'vetoed';
  const approved = o.approvedRev === o.rev && o.sendStatus === 'approved';

  return (
    <div className="plans-send">
      <div className="plans-meta">
        {o.ref && <>#{o.ref} · </>}to {o.to || '?'} · room {o.room || '?'} ·{' '}
        <strong>{approvalLine(o, mine)}</strong>
        {lastDecision?.action === 'send-hold' && (
          <> · held{lastDecision.detail.note ? `: ${lastDecision.detail.note as string}` : ''}</>
        )}
      </div>
      <pre className="plans-draft">{item.body.replace(/^\n+/, '')}</pre>

      {plan.decidesSends && !done && mode === null && (
        <div className="plans-row">
          {!approved && (
            <button
              type="button"
              className="plans-approve"
              onClick={() => void send({ action: 'approve', rev: o.rev })}
            >
              Approve rev {o.rev}
            </button>
          )}
          <button type="button" className="plans-secondary" onClick={() => setMode('hold')}>
            Hold
          </button>
          <button type="button" className="plans-danger" onClick={() => setMode('veto')}>
            Veto
          </button>
          <button type="button" className="plans-secondary" onClick={() => setMode('sent')}>
            Mark sent
          </button>
        </div>
      )}
      {mode === 'hold' || mode === 'veto' ? (
        <div className="plans-form">
          <textarea
            rows={2}
            placeholder={
              mode === 'veto' ? 'Why not? (required)' : 'Note (optional): not now because…'
            }
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="plans-row">
            <button type="button" className="plans-secondary" onClick={() => setMode(null)}>
              Cancel
            </button>
            {mode === 'hold' ? (
              <button
                type="button"
                className="plans-primary"
                onClick={() =>
                  void send({ action: 'hold', ...(note.trim() ? { note: note.trim() } : {}) })
                }
              >
                Hold it
              </button>
            ) : (
              <button
                type="button"
                className="plans-danger"
                disabled={!note.trim()}
                onClick={() => void send({ action: 'veto', reason: note.trim() })}
              >
                Veto
              </button>
            )}
          </div>
        </div>
      ) : null}
      {mode === 'sent' && (
        <div className="plans-form">
          <div className="plans-warn">
            {approved
              ? `Mark rev ${o.rev} as sent?`
              : `Rev ${o.rev} isn't approved here, so this records it as sent outside the queue.`}
          </div>
          <div className="plans-row">
            <button type="button" className="plans-secondary" onClick={() => setMode(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="plans-primary"
              onClick={() => void send({ action: 'sent' })}
            >
              It went out
            </button>
          </div>
        </div>
      )}
      {!plan.decidesSends && !done && (
        <div className="plans-meta">Only Kohl, from Kohl's own account, approves a send.</div>
      )}
    </div>
  );
}

// ── discussion and history ────────────────────────────────────────────

function describe(e: PlanEvent, plan: PlanDetail): string {
  const d = e.detail as Record<string, unknown>;
  const item = plan.items.find((i) => i.id === e.itemId)?.title;
  const phase = plan.phases.find((f) => f.id === e.phaseId)?.title;
  switch (e.action) {
    case 'plan-created':
      return 'started the plan';
    case 'plan-edited':
      return `edited the plan (${Object.keys((d.changes as object) ?? {}).join(', ')})`;
    case 'phase-added':
      return `added phase "${d.title as string}"`;
    case 'phase-edited':
      return `edited phase "${phase ?? ''}"`;
    case 'phase-proposed':
      return `proposed "${phase ?? ''}" for approval`;
    case 'phase-yes':
      return `said yes to "${phase ?? ''}"`;
    case 'phase-approved':
      return `"${phase ?? ''}" is approved`;
    case 'phase-declined':
      return `declined "${phase ?? ''}": ${d.reason as string}`;
    case 'phase-done':
      return `marked "${phase ?? ''}" done`;
    case 'approval-void':
      return `"${phase ?? ''}" changed after approval, so it needs approval again`;
    case 'item-added':
      return `added ${d.kind as string} item "${d.title as string}"`;
    case 'item-edited':
      return `edited "${item ?? ''}" (${Object.keys((d.changes as object) ?? {}).join(', ')})`;
    case 'item-status':
      return `moved "${item ?? ''}" to ${String(d.after).replace('_', ' ')}${d.resolution ? `: ${d.resolution as string}` : ''}`;
    case 'item-ordered':
      return `reordered "${item ?? ''}" (${Object.keys((d.changes as object) ?? {}).join(', ')})`;
    case 'send-approve':
      return `approved "${item ?? ''}" to send (rev ${String(d.rev)})`;
    case 'send-veto':
      return `vetoed "${item ?? ''}": ${String(d.reason ?? '')}`;
    case 'send-hold':
      return `held "${item ?? ''}" (rev ${String(d.rev)})${d.note ? `: ${d.note as string}` : ''}`;
    case 'send-sent':
      return `marked "${item ?? ''}" sent${d.outsideQueue ? ' (outside the queue)' : ''}`;
    case 'send-executed':
      return `carried out "${item ?? ''}" as approved (rev ${String(d.rev)}): ${String((d.receipt as { where?: string })?.where ?? '')} ${String((d.receipt as { ref?: string })?.ref ?? '')}`;
    case 'send-approval-void':
      return `"${item ?? ''}" changed after its send approval, so it needs a new yes`;
    case 'outreach-revised':
      return `revised "${item ?? ''}" (rev ${String(d.rev ?? '')})`;
    default:
      return e.action;
  }
}

function History({ plan, events, act }: { plan: PlanDetail; events: PlanEvent[]; act: Act }) {
  const [text, setText] = useState('');
  const [tab, setTab] = useState<'talk' | 'all'>('talk');
  const shown = useMemo(
    () => (tab === 'talk' ? events.filter((e) => e.action === 'comment') : events),
    [events, tab],
  );
  return (
    <aside className="plans-history" aria-label="Discussion and history">
      <div className="plans-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'talk'}
          onClick={() => setTab('talk')}
        >
          Discussion
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'all'}
          onClick={() => setTab('all')}
        >
          Everything ({events.length})
        </button>
      </div>
      <ol className="plans-events">
        {shown.length === 0 && <li className="plans-hint">Nothing yet.</li>}
        {shown.map((e) =>
          e.action === 'comment' ? (
            <li key={e.seq} className="plans-comment">
              <span className="plans-who">
                @{e.actor.name}{' '}
                <span className="plans-when">{new Date(e.at).toLocaleString()}</span>
              </span>
              <div
                className="plans-md"
                dangerouslySetInnerHTML={{
                  __html: md(String((e.detail as { body?: string }).body ?? '')),
                }}
              />
            </li>
          ) : (
            <li key={e.seq} className="plans-event">
              <span className="plans-who">@{e.actor.name}</span> {describe(e, plan)}
              <span className="plans-when">
                {' '}
                · {e.surface} · {new Date(e.at).toLocaleString()}
              </span>
            </li>
          ),
        )}
      </ol>
      <div className="plans-compose">
        <textarea
          rows={3}
          placeholder="Say something about this plan"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={async (e) => {
            if (e.key === 'Enter' && !e.shiftKey && text.trim()) {
              e.preventDefault();
              if (await act(`/plans/${plan.slug}/comments`, 'POST', { body: text.trim() }))
                setText('');
            }
          }}
        />
        <button
          type="button"
          className="plans-primary"
          disabled={!text.trim()}
          onClick={async () => {
            if (await act(`/plans/${plan.slug}/comments`, 'POST', { body: text.trim() }))
              setText('');
          }}
        >
          Send
        </button>
      </div>
    </aside>
  );
}

// ── [[plan:slug]] embeds ──────────────────────────────────────────────

function usePlan(slug: string, routeBase: string) {
  const [plan, setPlan] = useState<PlanDetail | null | 'missing'>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      call<PlanDetail>(`${routeBase}/plans/${encodeURIComponent(slug)}`).then(
        (d) => live && setPlan(d),
        () => live && setPlan((p) => (p && p !== 'missing' ? p : 'missing')),
      );
    void load();
    // A meeting's working draft changes while people talk: keep up.
    const id = setInterval(() => void load(), 15_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [slug, routeBase]);
  return plan;
}

function progress(plan: PlanDetail): string {
  const live = plan.phases.filter((f) => f.status !== 'declined');
  const ok = live.filter((f) => f.status === 'approved' || f.status === 'done').length;
  return `${ok} of ${live.length} phase${live.length === 1 ? '' : 's'} approved`;
}

function waitingOnYou(plan: PlanDetail): number {
  return plan.phases.filter((f) =>
    f.awaiting.some((n) => n.toLowerCase() === plan.you.toLowerCase()),
  ).length;
}

/** The card in a message: the plan's title, how far approval has got, and
 *  whether it's waiting on you. Click to open it. */
export function PlanInline(props: Record<string, unknown>) {
  const { slug, routeBase, onClick } = props as {
    slug: string;
    routeBase: string;
    onClick: () => void;
  };
  const plan = usePlan(slug, routeBase);
  if (plan === null) {
    return (
      <button type="button" className="poll-embed loading" onClick={onClick}>
        Loading plan…
      </button>
    );
  }
  if (plan === 'missing') {
    return <span className="poll-embed">Plan not found (or not in your servers)</span>;
  }
  const mine = waitingOnYou(plan);
  return (
    <button
      type="button"
      className="poll-embed ok plans-embed"
      onClick={onClick}
      aria-label={`Plan: ${plan.title}. ${progress(plan)}.${mine ? ' Waiting on your yes.' : ''} Open it.`}
    >
      <span className="poll-embed-body">
        <span className="poll-embed-question">🗺️ {plan.title}</span>
        <span className="poll-embed-meta">
          {progress(plan)} · {plan.items.length} items
          {mine ? ` · ${mine} waiting on your yes` : ''}
        </span>
      </span>
    </button>
  );
}

/** The embed sidebar: the whole plan beside the conversation (a meeting's
 *  working draft, say), refreshed as it changes. */
export function PlanPreview(props: Record<string, unknown>) {
  const { slug, routeBase } = props as { slug: string; routeBase: string };
  const plan = usePlan(slug, routeBase);
  if (plan === null) return <div className="poll-preview-loading">Loading plan…</div>;
  if (plan === 'missing') return <div className="poll-preview-error">Plan not found.</div>;
  return (
    <div className="plans-preview">
      <h2 className="poll-preview-question">{plan.title}</h2>
      {plan.goal && <p className="plans-goal-text">{plan.goal}</p>}
      {plan.phases
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((f) => (
          <section key={f.id} className={`plans-phase plans-phase-${f.status}`}>
            <div className="plans-phase-top">
              <h3>
                <span className="plans-phase-n">Phase {f.position + 1}</span> {f.title}
              </h3>
              <span className={`plans-chip plans-chip-${f.status}`}>{PHASE_LABEL[f.status]}</span>
            </div>
            {f.goal && <p className="plans-phase-goal">{f.goal}</p>}
            <ul className="plans-preview-items">
              {plan.items
                .filter((i) => i.phaseId === f.id)
                .map((i) => (
                  <li key={i.id} className={`plans-item-${i.status}`}>
                    <span className={`plans-kind plans-kind-${i.kind}`}>{i.kind}</span>{' '}
                    <span className="plans-item-title">{i.title}</span>
                    {i.owner && <span className="plans-item-owner"> @{i.owner}</span>}
                  </li>
                ))}
            </ul>
          </section>
        ))}
      <p className="plans-meta">
        {progress(plan)}. Updates every 15 seconds; approve phases in Plans.
      </p>
    </div>
  );
}
