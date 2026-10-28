// SPDX-License-Identifier: Hippocratic-3.0
import { useCallback, useEffect, useMemo, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type {
  ItemKind,
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
}: {
  routeBase: string;
  onClose: () => void;
  serverId: string | null;
}) {
  const [plans, setPlans] = useState<PlanSummary[] | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanDetail | null>(null);
  const [events, setEvents] = useState<PlanEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

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
          {plans?.length === 0 && <p className="plans-hint">No plans yet.</p>}
          <ul>
            {(plans ?? []).map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className={`plans-list-item${p.slug === slug ? ' plans-current' : ''}`}
                  aria-current={p.slug === slug ? 'true' : undefined}
                  onClick={() => {
                    setSlug(p.slug);
                    setCreating(false);
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
          ) : plan ? (
            <PlanBody plan={plan} act={act} />
          ) : (
            <p className="plans-hint">Pick a plan, or start one.</p>
          )}
        </main>

        {plan && !creating && <History plan={plan} events={events} act={act} />}
      </div>
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

function PlanBody({ plan, act }: { plan: PlanDetail; act: Act }) {
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
          act={act}
        />
      ))}

      {loose.length > 0 && (
        <section className="plans-phase">
          <h3>Not in a phase</h3>
          {loose.map((i) => (
            <ItemRow key={i.id} plan={plan} item={i} act={act} />
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
  act,
}: {
  plan: PlanDetail;
  phase: PlanPhase;
  items: PlanItem[];
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
      {phase.status === 'proposed' && (
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
        <ItemRow key={i.id} plan={plan} item={i} act={act} />
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

      <div className="plans-row plans-phase-actions">
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

function ItemRow({ plan, item, act }: { plan: PlanDetail; item: PlanItem; act: Act }) {
  const [open, setOpen] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [resolution, setResolution] = useState('');
  void plan;
  return (
    <div className={`plans-item plans-item-${item.status}`}>
      <button
        type="button"
        className="plans-item-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className={`plans-kind plans-kind-${item.kind}`}>{item.kind}</span>
        <span className="plans-item-title">{item.title}</span>
        {item.owner && <span className="plans-item-owner">@{item.owner}</span>}
        <span className="plans-item-status">{item.status.replace('_', ' ')}</span>
      </button>
      {open && (
        <div className="plans-item-body">
          {item.body && (
            <div className="plans-md" dangerouslySetInnerHTML={{ __html: md(item.body) }} />
          )}
          {item.resolution && (
            <div className="plans-resolution">
              <strong>Resolution:</strong> {item.resolution}
            </div>
          )}
          <div className="plans-meta">added by {item.createdBy.name}</div>
          {finishing ? (
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
