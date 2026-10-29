// SPDX-License-Identifier: MIT
import { definePlugin, canAccess } from '@babelr/plugin-sdk';
import { sql } from 'drizzle-orm';
import {
  decide,
  draftOf,
  edit as editDraft,
  lineDiff,
  setField as setFieldOf,
  split,
  SEND_STATUSES,
} from './outreach.js';
import type { SendStatus } from './outreach.js';

/**
 * Plans: the house's strategic planning, where everybody contributes and
 * the server's owner approves.
 *
 * Kohl, 2026-10-28: "a full strategic planning system, where queue items
 * can be grouped into phases and approved. Basically like your
 * roadmap/gameplan system, but in a space where *everybody* can
 * contribute to it." Approved build work is picked up by Daedalus
 * sessions; nothing here runs anything.
 *
 * The shape:
 *   - A plan (in a server) has a goal, a sequencing narrative, and
 *     ordered phases. A phase has a goal and items.
 *   - An item has a kind: build, outreach, research, decision or ask.
 *     Outreach items are reserved for phase 2 of this plan (folding
 *     RoboKohl's queue in); here they're plain items, and nothing here
 *     ever sends anything.
 *
 * Who decides:
 *   - Any member of the server (people and agents) can create plans,
 *     add and edit phases and items, comment, and propose a phase.
 *   - A phase is approved when every required approver has said yes:
 *     the server's owner, plus everyone the plan names in needsYesFrom
 *     (e.g. "cass" on a plan that concerns her). Any one of them can
 *     decline it, with a reason.
 *   - Approving a phase means "go do this work". It never approves a
 *     send (RoboKohl's rule 1).
 *   - Changing what an approved phase says (its goal, or an item's
 *     kind/title/body, or adding/moving an item into it) voids the
 *     approval: the phase goes back to proposed, approvals cleared.
 *     Item progress (start, done with a resolution, decline) doesn't.
 *   - A build item can only start once its phase is approved.
 *   - Only the owner or the person named can take a name off
 *     needsYesFrom; anyone can add one.
 *
 * The record: every change is an event (plugin_plans_events): who
 * (actor id and name), through which surface (the client's label:
 * "plans-view", "dm", "presence", ...; the actor is authoritative, the
 * surface is a label), what, when, and the text before and after for
 * edits. Comments are events too. Nothing is deleted: phases and items
 * are declined, not removed.
 *
 * Visibility: a plan is visible to members of its server only; anyone
 * else gets 404 for reads and writes alike. No WS broadcast; clients
 * refetch.
 */

export type ItemKind = 'build' | 'outreach' | 'research' | 'decision' | 'ask';
export const ITEM_KINDS: readonly ItemKind[] = ['build', 'outreach', 'research', 'decision', 'ask'];
export type PhaseStatus = 'draft' | 'proposed' | 'approved' | 'done' | 'declined';
export type ItemStatus = 'open' | 'in_progress' | 'done' | 'declined';
export type PlanStatus = 'draft' | 'active' | 'done' | 'archived';
export const PLAN_STATUSES: readonly PlanStatus[] = ['draft', 'active', 'done', 'archived'];

export interface Who {
  id: string;
  name: string;
}

export interface PlanItem {
  id: string;
  phaseId: string | null;
  position: number;
  kind: ItemKind;
  title: string;
  body: string;
  status: ItemStatus;
  owner: string | null;
  resolution: string;
  createdBy: Who;
  createdAt: string;
  updatedAt: string;
  /** Outreach items only: the queue file and where its send stands. */
  outreach?: Outreach;
}

export interface Outreach {
  /** The queue id (e.g. "0017"), when it came from or goes to a queue file. */
  ref: string | null;
  to: string;
  room: string;
  sendStatus: SendStatus;
  /** Revision of the draft; 1 is the original. */
  rev: number;
  /** The revision Kohl approved to send, while that approval holds. */
  approvedRev: number | null;
  /** The queue file, byte for byte as queue.py would write it. */
  raw: string;
}

export interface PlanPhase {
  id: string;
  position: number;
  title: string;
  goal: string;
  status: PhaseStatus;
  declineReason: string;
  approvals: { name: string; at: string }[];
  /** Usernames still to say yes, while proposed. */
  awaiting: string[];
  createdBy: Who;
  updatedAt: string;
}

export interface Plan {
  id: string;
  slug: string;
  serverId: string;
  title: string;
  goal: string;
  narrative: string;
  status: PlanStatus;
  needsYesFrom: string[];
  createdBy: Who;
  createdAt: string;
  updatedAt: string;
}

export interface PlanDetail extends Plan {
  phases: PlanPhase[];
  items: PlanItem[];
  /** Usernames whose yes approves a phase: the owner, then needsYesFrom. */
  approvers: string[];
  /** Whether the caller is one of them. */
  canApprove: boolean;
  /** The caller's username. */
  you: string;
}

export interface PlanSummary extends Plan {
  phaseCounts: Record<PhaseStatus, number>;
  itemCounts: { total: number; done: number };
  awaitingMe: number;
}

export interface PlanEvent {
  seq: number;
  phaseId: string | null;
  itemId: string | null;
  actor: Who;
  surface: string;
  action: string;
  detail: Record<string, unknown>;
  at: string;
}

export const LIMITS = { title: 300, goal: 4000, narrative: 20_000, body: 50_000, text: 20_000 };

export class PlanError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

function text(v: unknown, what: keyof typeof LIMITS, required = false): string {
  if (v === undefined || v === null) {
    if (required) throw new PlanError(`${what} is required`, 400);
    return '';
  }
  if (typeof v !== 'string' || v.length > LIMITS[what]) {
    throw new PlanError(`${what} must be a string up to ${LIMITS[what]} chars`, 400);
  }
  if (required && !v.trim()) throw new PlanError(`${what} is required`, 400);
  wallCheck(v);
  return v;
}

// RoboKohl's wall (Plans phase 3): nothing from its eval/ or data/ goes into
// a plan, phase, item or comment, so plan text never becomes a route past
// it. A backstop, not the wall: the wall is the queue adapter never reading
// those folders, and RoboKohl's CLAUDE.md. A filter can't recognize what's
// behind it by content, only paths, diff headers and the wall's own names.
const WALL: RegExp[] = [
  /(^|[\s`'"([<])(?:\.\/)?(?:eval|data)\/[\w.*-]/im, // eval/x, `data/open`, ./data/x, EVAL/x
  /robokohl[\w.-]*\/(?:eval|data)\//i, // ~/robokohl/eval/...
  /robokohl-(?:eval|family)/i, // ~/.local/share/robokohl-eval, the family room
  /^(?:---|\+\+\+) [ab]\/(?:eval|data)\//m, // a pasted diff of a file there
  /^diff --git a\/(?:eval|data)\//im, // its diff header alone
  /holdout_convs|ledger_runs/i, // the wall's own files
];

export function wallCheck(v: string): void {
  if (WALL.some((re) => re.test(v))) {
    throw new PlanError(
      "plans can't carry anything from behind RoboKohl's wall (its eval/ or data/, the family room); describe it without the path or the contents",
      400,
    );
  }
}

const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function names(v: unknown): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((n) => typeof n === 'string' && USERNAME_RE.test(n))) {
    throw new PlanError('needsYesFrom must be a list of usernames', 400);
  }
  return [...new Set((v as string[]).map((n) => n.toLowerCase()))];
}

function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `${base || 'plan'}-${Math.random().toString(36).slice(2, 7)}`;
}

/** The surface a change came through: a short label the client gives. */
function surfaceOf(headers: Record<string, unknown>, actor: Actor): string {
  const raw = headers['x-plans-surface'];
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (/^[a-z0-9][a-z0-9 _.-]{0,39}$/.test(s)) return s;
  return isAgent(actor) ? 'api' : 'plans-view';
}

type Actor = {
  id: string;
  uri: string;
  kind?: string;
  preferredUsername: string;
  displayName?: string | null;
};
const isAgent = (a: Actor) => a.kind === 'agent' || a.kind === 'service';
const iso = (v: string | Date) => new Date(v).toISOString();

// ── rows ─────────────────────────────────────────────────────────────

interface PlanRow {
  id: string;
  slug: string;
  server_id: string;
  title: string;
  goal: string;
  narrative: string;
  status: PlanStatus;
  needs_yes_from: string[] | string;
  created_by: string;
  created_by_name: string;
  created_at: string | Date;
  updated_at: string | Date;
}
interface PhaseRow {
  id: string;
  plan_id: string;
  position: number;
  title: string;
  goal: string;
  status: PhaseStatus;
  decline_reason: string;
  created_by: string;
  created_by_name: string;
  updated_at: string | Date;
}
interface ItemRow {
  id: string;
  plan_id: string;
  phase_id: string | null;
  position: number;
  kind: ItemKind;
  title: string;
  body: string;
  status: ItemStatus;
  owner: string | null;
  resolution: string;
  created_by: string;
  created_by_name: string;
  created_at: string | Date;
  updated_at: string | Date;
  o_ref: string | null;
  o_raw: string | null;
  o_rev: number | null;
  o_approved_rev: number | null;
}
interface ApprovalRow {
  phase_id: string;
  actor_name: string;
  approved_at: string | Date;
}
interface EventRow {
  seq: string | number;
  phase_id: string | null;
  item_id: string | null;
  actor_id: string;
  actor_name: string;
  surface: string;
  action: string;
  detail: Record<string, unknown> | string;
  at: string | Date;
}

const json = <T>(v: T | string): T => (typeof v === 'string' ? (JSON.parse(v) as T) : v);

function toPlan(r: PlanRow): Plan {
  return {
    id: r.id,
    slug: r.slug,
    serverId: r.server_id,
    title: r.title,
    goal: r.goal,
    narrative: r.narrative,
    status: r.status,
    needsYesFrom: json<string[]>(r.needs_yes_from),
    createdBy: { id: r.created_by, name: r.created_by_name },
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function toItem(r: ItemRow): PlanItem {
  return {
    id: r.id,
    phaseId: r.phase_id,
    position: Number(r.position),
    kind: r.kind,
    title: r.title,
    body: r.body,
    status: r.status,
    owner: r.owner,
    resolution: r.resolution,
    createdBy: { id: r.created_by, name: r.created_by_name },
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    ...(r.o_raw !== null && r.o_raw !== undefined ? { outreach: toOutreach(r) } : {}),
  };
}

function toOutreach(r: ItemRow): Outreach {
  const { meta } = split(r.o_raw as string);
  return {
    ref: r.o_ref,
    to: meta.to ?? '',
    room: meta.room ?? '',
    sendStatus: (SEND_STATUSES as readonly string[]).includes(meta.status)
      ? (meta.status as SendStatus)
      : 'pending',
    rev: Number(r.o_rev),
    approvedRev: r.o_approved_rev === null ? null : Number(r.o_approved_rev),
    raw: r.o_raw as string,
  };
}

/** Required approvers who haven't said yes. */
export function awaiting(approvers: string[], approvedBy: string[]): string[] {
  const done = new Set(approvedBy.map((n) => n.toLowerCase()));
  return approvers.filter((n) => !done.has(n.toLowerCase()));
}

const PLAN_SELECT = sql`SELECT p.*, COALESCE(a.preferred_username, '') AS created_by_name
  FROM plugin_plans_plans p LEFT JOIN actors a ON a.id::text = p.created_by`;
const PHASE_SELECT = sql`SELECT f.*, COALESCE(a.preferred_username, '') AS created_by_name
  FROM plugin_plans_phases f LEFT JOIN actors a ON a.id::text = f.created_by`;
const ITEM_SELECT = sql`SELECT i.*, COALESCE(a.preferred_username, '') AS created_by_name,
    o.ref AS o_ref, o.raw AS o_raw, o.rev AS o_rev, o.approved_rev AS o_approved_rev
  FROM plugin_plans_items i LEFT JOIN actors a ON a.id::text = i.created_by
  LEFT JOIN plugin_plans_outreach o ON o.item_id = i.id`;

export default definePlugin({
  id: 'plans',
  name: 'Plans',
  version: '0.1.0',
  description: 'Plans, phases and items anyone in the server can shape; the owner approves.',
  dependencies: { babelr: '^0.1.0' },

  migrations: [
    {
      id: 1,
      name: 'init',
      up: `
        CREATE TABLE IF NOT EXISTS plugin_plans_plans (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          slug TEXT NOT NULL UNIQUE,
          server_id TEXT NOT NULL,
          title TEXT NOT NULL,
          goal TEXT NOT NULL DEFAULT '',
          narrative TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'draft',
          needs_yes_from JSONB NOT NULL DEFAULT '[]'::jsonb,
          created_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS plugin_plans_plans_server_idx ON plugin_plans_plans (server_id);

        CREATE TABLE IF NOT EXISTS plugin_plans_phases (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          plan_id UUID NOT NULL REFERENCES plugin_plans_plans(id) ON DELETE CASCADE,
          position INTEGER NOT NULL DEFAULT 0,
          title TEXT NOT NULL,
          goal TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'draft',
          decline_reason TEXT NOT NULL DEFAULT '',
          created_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS plugin_plans_approvals (
          phase_id UUID NOT NULL REFERENCES plugin_plans_phases(id) ON DELETE CASCADE,
          actor_id TEXT NOT NULL,
          actor_name TEXT NOT NULL,
          approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (phase_id, actor_id)
        );

        CREATE TABLE IF NOT EXISTS plugin_plans_items (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          plan_id UUID NOT NULL REFERENCES plugin_plans_plans(id) ON DELETE CASCADE,
          phase_id UUID REFERENCES plugin_plans_phases(id) ON DELETE SET NULL,
          position INTEGER NOT NULL DEFAULT 0,
          kind TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'open',
          owner TEXT,
          resolution TEXT NOT NULL DEFAULT '',
          created_by TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS plugin_plans_events (
          seq BIGSERIAL PRIMARY KEY,
          plan_id UUID NOT NULL REFERENCES plugin_plans_plans(id) ON DELETE CASCADE,
          phase_id UUID,
          item_id UUID,
          actor_id TEXT NOT NULL,
          actor_name TEXT NOT NULL,
          surface TEXT NOT NULL,
          action TEXT NOT NULL,
          detail JSONB NOT NULL DEFAULT '{}'::jsonb,
          at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS plugin_plans_events_plan_idx ON plugin_plans_events (plan_id, seq);
      `,
    },
    {
      id: 2,
      name: 'outreach',
      up: `
        CREATE TABLE IF NOT EXISTS plugin_plans_outreach (
          item_id UUID PRIMARY KEY REFERENCES plugin_plans_items(id) ON DELETE CASCADE,
          ref TEXT,
          raw TEXT NOT NULL,
          rev INTEGER NOT NULL DEFAULT 1,
          approved_rev INTEGER
        );

        CREATE UNIQUE INDEX IF NOT EXISTS plugin_plans_outreach_ref_idx
          ON plugin_plans_outreach (ref) WHERE ref IS NOT NULL;

        CREATE TABLE IF NOT EXISTS plugin_plans_revisions (
          item_id UUID NOT NULL REFERENCES plugin_plans_items(id) ON DELETE CASCADE,
          rev INTEGER NOT NULL,
          draft TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          actor_name TEXT NOT NULL,
          surface TEXT NOT NULL,
          seen_rev INTEGER,
          cause_msg TEXT,
          verified BOOLEAN NOT NULL DEFAULT TRUE,
          claimed TEXT,
          at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (item_id, rev)
        );
      `,
    },
  ],

  serverRoutes: async (fastify) => {
    const db = fastify.db;

    fastify.addHook('onRequest', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
    });

    function fail(
      reply: { status: (n: number) => { send: (b: unknown) => unknown } },
      err: unknown,
    ) {
      if (err instanceof PlanError) return reply.status(err.status).send({ error: err.message });
      throw err;
    }

    function me(request: { actor?: unknown }): Actor {
      const a = request.actor as Actor | undefined;
      if (!a) throw new PlanError('Not authenticated', 401);
      return a;
    }

    async function ownerName(serverId: string): Promise<string | null> {
      const rows = (await db.execute(
        sql`SELECT o.preferred_username AS name FROM actors s
            JOIN actors o ON o.id::text = s.properties->>'ownerId'
            WHERE s.id::text = ${serverId}`,
      )) as unknown as { name: string }[];
      return rows[0]?.name ?? null;
    }

    async function approversOf(plan: Plan): Promise<string[]> {
      const owner = await ownerName(plan.serverId);
      const out = owner ? [owner] : [];
      for (const n of plan.needsYesFrom) if (!out.some((o) => o.toLowerCase() === n)) out.push(n);
      return out;
    }

    /** The plan `slug`, if the caller is in its server; else the missing-plan 404. */
    async function planFor(actor: Actor, slug: string): Promise<Plan> {
      const rows = (await db.execute(
        sql`${PLAN_SELECT} WHERE p.slug = ${slug}`,
      )) as unknown as PlanRow[];
      const plan = rows[0] ? toPlan(rows[0]) : null;
      if (!plan || !(await canAccess(fastify, actor, plan.serverId))) {
        throw new PlanError('plan not found', 404);
      }
      return plan;
    }

    async function planById(actor: Actor, id: string): Promise<Plan> {
      const rows = (await db.execute(
        sql`${PLAN_SELECT} WHERE p.id = ${id}`,
      )) as unknown as PlanRow[];
      const plan = rows[0] ? toPlan(rows[0]) : null;
      if (!plan || !(await canAccess(fastify, actor, plan.serverId))) {
        throw new PlanError('not found', 404);
      }
      return plan;
    }

    async function phaseFor(actor: Actor, id: string): Promise<{ plan: Plan; phase: PhaseRow }> {
      if (!UUID_RE.test(id)) throw new PlanError('phase not found', 404);
      const rows = (await db.execute(
        sql`${PHASE_SELECT} WHERE f.id = ${id}`,
      )) as unknown as PhaseRow[];
      if (!rows[0]) throw new PlanError('phase not found', 404);
      return { plan: await planById(actor, rows[0].plan_id), phase: rows[0] };
    }

    async function itemFor(actor: Actor, id: string): Promise<{ plan: Plan; item: ItemRow }> {
      if (!UUID_RE.test(id)) throw new PlanError('item not found', 404);
      const rows = (await db.execute(
        sql`${ITEM_SELECT} WHERE i.id = ${id}`,
      )) as unknown as ItemRow[];
      if (!rows[0]) throw new PlanError('item not found', 404);
      return { plan: await planById(actor, rows[0].plan_id), item: rows[0] };
    }

    async function log(
      plan: Plan,
      actor: Actor,
      surface: string,
      action: string,
      detail: Record<string, unknown> = {},
      ids: { phaseId?: string | null; itemId?: string | null } = {},
    ) {
      await db.execute(
        sql`INSERT INTO plugin_plans_events (plan_id, phase_id, item_id, actor_id, actor_name, surface, action, detail)
            VALUES (${plan.id}, ${ids.phaseId ?? null}, ${ids.itemId ?? null}, ${actor.id},
                    ${actor.preferredUsername}, ${surface}, ${action}, ${JSON.stringify(detail)}::jsonb)`,
      );
      await db.execute(sql`UPDATE plugin_plans_plans SET updated_at = NOW() WHERE id = ${plan.id}`);
    }

    /** An approved phase's text changed: the approval no longer holds. */
    async function voidApproval(plan: Plan, phaseId: string | null, actor: Actor, surface: string) {
      if (!phaseId) return;
      const rows = (await db.execute(
        sql`UPDATE plugin_plans_phases SET status = 'proposed', updated_at = NOW()
            WHERE id = ${phaseId} AND status = 'approved' RETURNING id`,
      )) as unknown as { id: string }[];
      if (!rows.length) return;
      await db.execute(sql`DELETE FROM plugin_plans_approvals WHERE phase_id = ${phaseId}`);
      await log(
        plan,
        actor,
        surface,
        'approval-void',
        { why: 'its text changed after approval' },
        { phaseId },
      );
    }

    async function detail(plan: Plan, actor: Actor): Promise<PlanDetail> {
      const phases = (await db.execute(
        sql`${PHASE_SELECT} WHERE f.plan_id = ${plan.id} ORDER BY f.position, f.created_at`,
      )) as unknown as PhaseRow[];
      const items = (await db.execute(
        sql`${ITEM_SELECT} WHERE i.plan_id = ${plan.id} ORDER BY i.position, i.created_at`,
      )) as unknown as ItemRow[];
      const approvals = (await db.execute(
        sql`SELECT a.phase_id, a.actor_name, a.approved_at FROM plugin_plans_approvals a
            JOIN plugin_plans_phases f ON f.id = a.phase_id WHERE f.plan_id = ${plan.id}`,
      )) as unknown as ApprovalRow[];
      const approvers = await approversOf(plan);
      return {
        ...plan,
        approvers,
        canApprove: approvers.some(
          (n) => n.toLowerCase() === actor.preferredUsername.toLowerCase(),
        ),
        you: actor.preferredUsername,
        phases: phases.map((f) => {
          const mine = approvals.filter((a) => a.phase_id === f.id);
          return {
            id: f.id,
            position: Number(f.position),
            title: f.title,
            goal: f.goal,
            status: f.status,
            declineReason: f.decline_reason,
            approvals: mine.map((a) => ({ name: a.actor_name, at: iso(a.approved_at) })),
            awaiting:
              f.status === 'proposed'
                ? awaiting(
                    approvers,
                    mine.map((a) => a.actor_name),
                  )
                : [],
            createdBy: { id: f.created_by, name: f.created_by_name },
            updatedAt: iso(f.updated_at),
          };
        }),
        items: items.map(toItem),
      };
    }

    // ── plans ──────────────────────────────────────────────────────────

    fastify.get<{ Querystring: { serverId?: string } }>('/plans', async (request, reply) => {
      try {
        const actor = me(request);
        const { serverId } = request.query;
        const rows = (await db.execute(
          serverId
            ? sql`${PLAN_SELECT} WHERE p.server_id = ${serverId} ORDER BY p.updated_at DESC`
            : sql`${PLAN_SELECT} ORDER BY p.updated_at DESC`,
        )) as unknown as PlanRow[];
        const member = new Map<string, boolean>();
        const out: PlanSummary[] = [];
        for (const r of rows) {
          if (!member.has(r.server_id)) {
            member.set(r.server_id, await canAccess(fastify, actor, r.server_id));
          }
          if (!member.get(r.server_id)) continue;
          const plan = toPlan(r);
          const d = await detail(plan, actor);
          const phaseCounts = { draft: 0, proposed: 0, approved: 0, done: 0, declined: 0 };
          for (const f of d.phases) phaseCounts[f.status] += 1;
          const mine = actor.preferredUsername.toLowerCase();
          out.push({
            ...plan,
            phaseCounts,
            itemCounts: {
              total: d.items.filter((i) => i.status !== 'declined').length,
              done: d.items.filter((i) => i.status === 'done').length,
            },
            awaitingMe: d.phases.filter((f) => f.awaiting.some((n) => n.toLowerCase() === mine))
              .length,
          });
        }
        return out;
      } catch (err) {
        return fail(reply, err);
      }
    });

    fastify.post<{ Body: Record<string, unknown> }>('/plans', async (request, reply) => {
      try {
        const actor = me(request);
        const b = request.body ?? {};
        const serverId = typeof b.serverId === 'string' ? b.serverId : '';
        if (!serverId || !(await canAccess(fastify, actor, serverId))) {
          throw new PlanError('server not found', 404);
        }
        const title = text(b.title, 'title', true);
        const goal = text(b.goal, 'goal');
        const narrative = text(b.narrative, 'narrative');
        const needs = names(b.needsYesFrom);
        const slug = slugify(title);
        await db.execute(
          sql`INSERT INTO plugin_plans_plans (slug, server_id, title, goal, narrative, needs_yes_from, created_by)
              VALUES (${slug}, ${serverId}, ${title}, ${goal}, ${narrative},
                      ${JSON.stringify(needs)}::jsonb, ${actor.id})`,
        );
        const plan = await planFor(actor, slug);
        await log(plan, actor, surfaceOf(request.headers, actor), 'plan-created', {
          title,
          goal,
          narrative,
          needsYesFrom: needs,
        });
        return reply.status(201).send(await detail(plan, actor));
      } catch (err) {
        return fail(reply, err);
      }
    });

    fastify.get<{ Params: { slug: string } }>('/plans/:slug', async (request, reply) => {
      try {
        const actor = me(request);
        return await detail(await planFor(actor, request.params.slug), actor);
      } catch (err) {
        return fail(reply, err);
      }
    });

    fastify.patch<{ Params: { slug: string }; Body: Record<string, unknown> }>(
      '/plans/:slug',
      async (request, reply) => {
        try {
          const actor = me(request);
          const plan = await planFor(actor, request.params.slug);
          const b = request.body ?? {};
          const surface = surfaceOf(request.headers, actor);
          const changes: Record<string, { before: unknown; after: unknown }> = {};
          const next = { ...plan };
          for (const [k, lim] of [
            ['title', 'title'],
            ['goal', 'goal'],
            ['narrative', 'narrative'],
          ] as const) {
            if (b[k] !== undefined) {
              const v = text(b[k], lim, k === 'title');
              if (v !== plan[k]) {
                changes[k] = { before: plan[k], after: v };
                next[k] = v;
              }
            }
          }
          if (b.status !== undefined) {
            if (!PLAN_STATUSES.includes(b.status as PlanStatus)) {
              throw new PlanError(`status must be one of ${PLAN_STATUSES.join(', ')}`, 400);
            }
            if (b.status !== plan.status) {
              changes.status = { before: plan.status, after: b.status };
              next.status = b.status as PlanStatus;
            }
          }
          if (b.needsYesFrom !== undefined) {
            const want = names(b.needsYesFrom);
            const removed = plan.needsYesFrom.filter((n) => !want.includes(n));
            const owner = (await ownerName(plan.serverId))?.toLowerCase();
            const mine = actor.preferredUsername.toLowerCase();
            for (const n of removed) {
              if (n !== mine && owner !== mine) {
                throw new PlanError(`only ${n} or the server's owner can take ${n} off`, 403);
              }
            }
            if (JSON.stringify(want) !== JSON.stringify(plan.needsYesFrom)) {
              changes.needsYesFrom = { before: plan.needsYesFrom, after: want };
              next.needsYesFrom = want;
            }
          }
          if (Object.keys(changes).length) {
            await db.execute(
              sql`UPDATE plugin_plans_plans SET title = ${next.title}, goal = ${next.goal},
                  narrative = ${next.narrative}, status = ${next.status},
                  needs_yes_from = ${JSON.stringify(next.needsYesFrom)}::jsonb, updated_at = NOW()
                  WHERE id = ${plan.id}`,
            );
            await log(plan, actor, surface, 'plan-edited', { changes });
            if (changes.needsYesFrom) {
              // A new required approver hasn't seen what's proposed yet.
              const added = next.needsYesFrom.filter((n) => !plan.needsYesFrom.includes(n));
              if (added.length) {
                const approved = (await db.execute(
                  sql`SELECT id FROM plugin_plans_phases WHERE plan_id = ${plan.id} AND status = 'approved'`,
                )) as unknown as { id: string }[];
                for (const f of approved) await voidApproval(next, f.id, actor, surface);
              }
            }
          }
          return await detail(await planFor(actor, plan.slug), actor);
        } catch (err) {
          return fail(reply, err);
        }
      },
    );

    // ── phases ─────────────────────────────────────────────────────────

    fastify.post<{ Params: { slug: string }; Body: Record<string, unknown> }>(
      '/plans/:slug/phases',
      async (request, reply) => {
        try {
          const actor = me(request);
          const plan = await planFor(actor, request.params.slug);
          const b = request.body ?? {};
          const title = text(b.title, 'title', true);
          const goal = text(b.goal, 'goal');
          const pos = (await db.execute(
            sql`SELECT COALESCE(MAX(position), -1) + 1 AS n FROM plugin_plans_phases WHERE plan_id = ${plan.id}`,
          )) as unknown as { n: number }[];
          const rows = (await db.execute(
            sql`INSERT INTO plugin_plans_phases (plan_id, position, title, goal, created_by)
                VALUES (${plan.id}, ${Number(pos[0].n)}, ${title}, ${goal}, ${actor.id}) RETURNING id`,
          )) as unknown as { id: string }[];
          await log(
            plan,
            actor,
            surfaceOf(request.headers, actor),
            'phase-added',
            { title, goal },
            { phaseId: rows[0].id },
          );
          return reply.status(201).send(await detail(plan, actor));
        } catch (err) {
          return fail(reply, err);
        }
      },
    );

    fastify.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
      '/phases/:id',
      async (request, reply) => {
        try {
          const actor = me(request);
          const { plan, phase } = await phaseFor(actor, request.params.id);
          const b = request.body ?? {};
          const surface = surfaceOf(request.headers, actor);
          const title = b.title !== undefined ? text(b.title, 'title', true) : phase.title;
          const goal = b.goal !== undefined ? text(b.goal, 'goal') : phase.goal;
          const position =
            b.position !== undefined && Number.isInteger(b.position)
              ? (b.position as number)
              : Number(phase.position);
          const changes: Record<string, { before: unknown; after: unknown }> = {};
          if (title !== phase.title) changes.title = { before: phase.title, after: title };
          if (goal !== phase.goal) changes.goal = { before: phase.goal, after: goal };
          if (position !== Number(phase.position)) {
            changes.position = { before: Number(phase.position), after: position };
          }
          if (Object.keys(changes).length) {
            await db.execute(
              sql`UPDATE plugin_plans_phases SET title = ${title}, goal = ${goal}, position = ${position},
                  updated_at = NOW() WHERE id = ${phase.id}`,
            );
            await log(plan, actor, surface, 'phase-edited', { changes }, { phaseId: phase.id });
            if (changes.title || changes.goal) await voidApproval(plan, phase.id, actor, surface);
          }
          return await detail(plan, actor);
        } catch (err) {
          return fail(reply, err);
        }
      },
    );

    async function setPhase(
      plan: Plan,
      phase: PhaseRow,
      actor: Actor,
      surface: string,
      status: PhaseStatus,
      action: string,
      extra: Record<string, unknown> = {},
      reason = '',
    ) {
      await db.execute(
        sql`UPDATE plugin_plans_phases SET status = ${status}, decline_reason = ${reason},
            updated_at = NOW() WHERE id = ${phase.id}`,
      );
      await log(plan, actor, surface, action, extra, { phaseId: phase.id });
    }

    fastify.post<{ Params: { id: string } }>('/phases/:id/propose', async (request, reply) => {
      try {
        const actor = me(request);
        const { plan, phase } = await phaseFor(actor, request.params.id);
        if (phase.status !== 'draft' && phase.status !== 'declined') {
          throw new PlanError(`a ${phase.status} phase can't be proposed`, 409);
        }
        await db.execute(sql`DELETE FROM plugin_plans_approvals WHERE phase_id = ${phase.id}`);
        await setPhase(
          plan,
          phase,
          actor,
          surfaceOf(request.headers, actor),
          'proposed',
          'phase-proposed',
        );
        return await detail(plan, actor);
      } catch (err) {
        return fail(reply, err);
      }
    });

    fastify.post<{ Params: { id: string } }>('/phases/:id/approve', async (request, reply) => {
      try {
        const actor = me(request);
        const { plan, phase } = await phaseFor(actor, request.params.id);
        const approvers = await approversOf(plan);
        const mine = actor.preferredUsername.toLowerCase();
        if (!approvers.some((n) => n.toLowerCase() === mine)) {
          throw new PlanError(
            `only ${approvers.join(' and ') || "the server's owner"} can approve a phase`,
            403,
          );
        }
        if (phase.status !== 'proposed') {
          throw new PlanError(
            `only a proposed phase can be approved (this one is ${phase.status})`,
            409,
          );
        }
        const surface = surfaceOf(request.headers, actor);
        await db.execute(
          sql`INSERT INTO plugin_plans_approvals (phase_id, actor_id, actor_name)
              VALUES (${phase.id}, ${actor.id}, ${actor.preferredUsername})
              ON CONFLICT (phase_id, actor_id) DO NOTHING`,
        );
        await log(plan, actor, surface, 'phase-yes', {}, { phaseId: phase.id });
        const said = (await db.execute(
          sql`SELECT actor_name FROM plugin_plans_approvals WHERE phase_id = ${phase.id}`,
        )) as unknown as { actor_name: string }[];
        const left = awaiting(
          approvers,
          said.map((r) => r.actor_name),
        );
        if (left.length === 0) {
          await setPhase(plan, phase, actor, surface, 'approved', 'phase-approved', {
            approvers,
          });
        }
        return await detail(plan, actor);
      } catch (err) {
        return fail(reply, err);
      }
    });

    fastify.post<{ Params: { id: string }; Body: { reason?: unknown } }>(
      '/phases/:id/decline',
      async (request, reply) => {
        try {
          const actor = me(request);
          const { plan, phase } = await phaseFor(actor, request.params.id);
          const approvers = await approversOf(plan);
          if (!approvers.some((n) => n.toLowerCase() === actor.preferredUsername.toLowerCase())) {
            throw new PlanError('only an approver can decline a phase', 403);
          }
          if (phase.status !== 'proposed' && phase.status !== 'approved') {
            throw new PlanError(`a ${phase.status} phase can't be declined`, 409);
          }
          const reason = text(request.body?.reason, 'text', true);
          await db.execute(sql`DELETE FROM plugin_plans_approvals WHERE phase_id = ${phase.id}`);
          await setPhase(
            plan,
            phase,
            actor,
            surfaceOf(request.headers, actor),
            'declined',
            'phase-declined',
            { reason },
            reason,
          );
          return await detail(plan, actor);
        } catch (err) {
          return fail(reply, err);
        }
      },
    );

    fastify.post<{ Params: { id: string }; Body: { resolution?: unknown } }>(
      '/phases/:id/done',
      async (request, reply) => {
        try {
          const actor = me(request);
          const { plan, phase } = await phaseFor(actor, request.params.id);
          if (phase.status !== 'approved') {
            throw new PlanError('only an approved phase can be marked done', 409);
          }
          const resolution = text(request.body?.resolution, 'text');
          await setPhase(
            plan,
            phase,
            actor,
            surfaceOf(request.headers, actor),
            'done',
            'phase-done',
            {
              resolution,
            },
          );
          return await detail(plan, actor);
        } catch (err) {
          return fail(reply, err);
        }
      },
    );

    // ── items ──────────────────────────────────────────────────────────

    /** Move an item to another plan (and optionally a phase of it). History
     * stays where it happened; each plan logs its side. A send approval is
     * about the draft, not its plan, so it holds; phase approvals on both
     * sides don't, since what they approved changed. */
    async function moveItem(
      plan: Plan,
      item: ItemRow,
      actor: Actor,
      surface: string,
      b: Record<string, unknown>,
    ): Promise<Plan> {
      const extra = Object.keys(b).filter((k) => k !== 'planSlug' && k !== 'phaseId');
      if (extra.length) {
        throw new PlanError(`move first, then edit (${extra.join(', ')} came with planSlug)`, 400);
      }
      if (typeof b.planSlug !== 'string') throw new PlanError('planSlug must be a plan slug', 400);
      const target = await planFor(actor, b.planSlug);
      const phaseId = await phaseIn(target, b.phaseId);
      const pos = (await db.execute(
        sql`SELECT COALESCE(MAX(position), -1) + 1 AS n FROM plugin_plans_items WHERE plan_id = ${target.id}`,
      )) as unknown as { n: number }[];
      await db.execute(
        sql`UPDATE plugin_plans_items SET plan_id = ${target.id}, phase_id = ${phaseId},
            position = ${Number(pos[0]?.n ?? 0)}, updated_at = NOW() WHERE id = ${item.id}`,
      );
      await log(
        plan,
        actor,
        surface,
        'item-moved-out',
        { to: target.slug, title: item.title },
        {
          phaseId: item.phase_id,
          itemId: item.id,
        },
      );
      await log(
        target,
        actor,
        surface,
        'item-moved-in',
        { from: plan.slug, title: item.title },
        {
          phaseId,
          itemId: item.id,
        },
      );
      await voidApproval(plan, item.phase_id, actor, surface);
      await voidApproval(target, phaseId, actor, surface);
      return target;
    }

    async function phaseIn(plan: Plan, phaseId: unknown): Promise<string | null> {
      if (phaseId === undefined || phaseId === null) return null;
      if (typeof phaseId !== 'string' || !UUID_RE.test(phaseId)) {
        throw new PlanError('phaseId must be a phase of this plan', 400);
      }
      const rows = (await db.execute(
        sql`SELECT id FROM plugin_plans_phases WHERE id = ${phaseId} AND plan_id = ${plan.id}`,
      )) as unknown as { id: string }[];
      if (!rows[0]) throw new PlanError('phaseId must be a phase of this plan', 400);
      return phaseId;
    }

    function kindOf(v: unknown): ItemKind {
      if (typeof v !== 'string' || !ITEM_KINDS.includes(v as ItemKind)) {
        throw new PlanError(`kind must be one of ${ITEM_KINDS.join(', ')}`, 400);
      }
      return v as ItemKind;
    }

    function ownerOf(v: unknown): string | null {
      if (v === undefined || v === null || v === '') return null;
      if (typeof v !== 'string' || !USERNAME_RE.test(v)) {
        throw new PlanError('owner must be a username', 400);
      }
      return v.toLowerCase();
    }

    fastify.post<{ Params: { slug: string }; Body: Record<string, unknown> }>(
      '/plans/:slug/items',
      async (request, reply) => {
        try {
          const actor = me(request);
          const plan = await planFor(actor, request.params.slug);
          const b = request.body ?? {};
          const surface = surfaceOf(request.headers, actor);
          const phaseId = await phaseIn(plan, b.phaseId);
          const kind = kindOf(b.kind);
          const title = text(b.title, 'title', true);
          const outreach = kind === 'outreach' ? outreachIn(b.outreach) : null;
          const body = outreach ? draftOf(outreach.raw) : text(b.body, 'body');
          const owner = ownerOf(b.owner);
          const pos = (await db.execute(
            sql`SELECT COALESCE(MAX(position), -1) + 1 AS n FROM plugin_plans_items WHERE plan_id = ${plan.id}`,
          )) as unknown as { n: number }[];
          const rows = (await db.execute(
            sql`INSERT INTO plugin_plans_items (plan_id, phase_id, position, kind, title, body, owner, created_by)
                VALUES (${plan.id}, ${phaseId}, ${Number(pos[0].n)}, ${kind}, ${title}, ${body}, ${owner}, ${actor.id})
                RETURNING id`,
          )) as unknown as { id: string }[];
          await log(
            plan,
            actor,
            surface,
            'item-added',
            { kind, title, body, owner, ...(outreach ? { ref: outreach.ref } : {}) },
            { phaseId, itemId: rows[0].id },
          );
          if (outreach) {
            // Outreach never waits on (or voids) a phase approval: its send
            // approval is its own, per item, Kohl's.
            await db.execute(
              sql`INSERT INTO plugin_plans_outreach (item_id, ref, raw) VALUES (${rows[0].id}, ${outreach.ref}, ${outreach.raw})`,
            );
            await addRevision(rows[0].id, 1, body, actor, surface, null, causeOf(b));
          } else {
            await voidApproval(plan, phaseId, actor, surface);
          }
          return reply.status(201).send(await detail(plan, actor));
        } catch (err) {
          return fail(reply, err);
        }
      },
    );

    fastify.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
      '/items/:id',
      async (request, reply) => {
        try {
          const actor = me(request);
          const { plan, item } = await itemFor(actor, request.params.id);
          const b = request.body ?? {};
          const surface = surfaceOf(request.headers, actor);
          if (b.planSlug !== undefined && b.planSlug !== plan.slug) {
            return await detail(await moveItem(plan, item, actor, surface, b), actor);
          }
          if (item.kind === 'outreach' && item.o_raw !== null) {
            await reviseOutreach(plan, item, actor, surface, b);
            return await detail(plan, actor);
          }
          const next = {
            kind: b.kind !== undefined ? kindOf(b.kind) : item.kind,
            title: b.title !== undefined ? text(b.title, 'title', true) : item.title,
            body: b.body !== undefined ? text(b.body, 'body') : item.body,
            owner: b.owner !== undefined ? ownerOf(b.owner) : item.owner,
            phaseId: b.phaseId !== undefined ? await phaseIn(plan, b.phaseId) : item.phase_id,
            // Order within the plan: moving an item up or down says nothing
            // new, so it never voids an approval.
            position:
              b.position !== undefined && Number.isInteger(b.position)
                ? (b.position as number)
                : Number(item.position),
          };
          const changes: Record<string, { before: unknown; after: unknown }> = {};
          const before = {
            kind: item.kind,
            title: item.title,
            body: item.body,
            owner: item.owner,
            phaseId: item.phase_id,
            position: Number(item.position),
          };
          for (const k of Object.keys(next) as (keyof typeof next)[]) {
            if (next[k] !== before[k]) changes[k] = { before: before[k], after: next[k] };
          }
          if (Object.keys(changes).length) {
            await db.execute(
              sql`UPDATE plugin_plans_items SET kind = ${next.kind}, title = ${next.title}, body = ${next.body},
                  owner = ${next.owner}, phase_id = ${next.phaseId}, position = ${next.position},
                  updated_at = NOW()
                  WHERE id = ${item.id}`,
            );
            await log(
              plan,
              actor,
              surface,
              'item-edited',
              { changes },
              {
                phaseId: next.phaseId,
                itemId: item.id,
              },
            );
            if (changes.kind || changes.title || changes.body || changes.phaseId) {
              await voidApproval(plan, item.phase_id, actor, surface);
              if (changes.phaseId) await voidApproval(plan, next.phaseId, actor, surface);
            }
          }
          return await detail(plan, actor);
        } catch (err) {
          return fail(reply, err);
        }
      },
    );

    // ── outreach (RoboKohl's queue, Plans phase 3) ──────────────────────

    /** Local date, as queue.py's today() writes it. */
    const today = () => new Date().toLocaleDateString('en-CA');

    /** The server's owner, as a person: never an agent or service token,
     * whatever surface it claims (the header is a label; the actor is auth). */
    async function isKohl(plan: Plan, actor: Actor): Promise<boolean> {
      if (isAgent(actor)) return false;
      const owner = await ownerName(plan.serverId);
      return !!owner && owner.toLowerCase() === actor.preferredUsername.toLowerCase();
    }

    /** The name queue files record: "kohl" for the owner, else the username. */
    const queueName = async (plan: Plan, actor: Actor) =>
      (await isKohl(plan, actor)) ? 'kohl' : actor.preferredUsername.toLowerCase();

    function outreachIn(v: unknown): { raw: string; ref: string | null } {
      const o = (v ?? {}) as Record<string, unknown>;
      const raw = text(o.raw, 'body', true);
      const ref = o.ref === undefined || o.ref === null ? null : String(o.ref);
      if (ref !== null && !/^\d{4}$/.test(ref))
        throw new PlanError('outreach.ref must be four digits', 400);
      const { head, meta } = split(raw);
      if (!head)
        throw new PlanError(
          'outreach.raw must be a queue file (a --- header, then the draft)',
          400,
        );
      if (!meta.to || !meta.room) {
        throw new PlanError("an outreach item needs who it's to and its room: know the room", 400);
      }
      if (meta.status !== 'pending') throw new PlanError('a new outreach item starts pending', 400);
      if (!draftOf(raw).trim()) throw new PlanError('an outreach item needs a draft', 400);
      return { raw, ref };
    }

    const causeOf = (b: Record<string, unknown>) =>
      typeof b.causeMsg === 'string' && /^[\w:-]{1,100}$/.test(b.causeMsg) ? b.causeMsg : null;

    async function addRevision(
      itemId: string,
      rev: number,
      draft: string,
      actor: Actor,
      surface: string,
      seenRev: number | null,
      causeMsg: string | null,
      claimed: string | null = null,
    ) {
      await db.execute(
        sql`INSERT INTO plugin_plans_revisions (item_id, rev, draft, actor_id, actor_name, surface, seen_rev, cause_msg, verified, claimed)
            VALUES (${itemId}, ${rev}, ${draft}, ${actor.id}, ${actor.preferredUsername}, ${surface}, ${seenRev}, ${causeMsg}, ${claimed === null}, ${claimed})`,
      );
    }

    async function revisionDraft(itemId: string, rev: number): Promise<string | null> {
      const rows = (await db.execute(
        sql`SELECT draft FROM plugin_plans_revisions WHERE item_id = ${itemId} AND rev = ${rev}`,
      )) as unknown as { draft: string }[];
      return rows[0]?.draft ?? null;
    }

    /** Store a new queue file for an outreach item; a text change voids the send approval. */
    async function saveOutreach(
      plan: Plan,
      item: ItemRow,
      actor: Actor,
      surface: string,
      raw: string,
      newRev: boolean,
    ) {
      await db.execute(
        sql`UPDATE plugin_plans_outreach SET raw = ${raw}, rev = rev + ${newRev ? 1 : 0},
            approved_rev = CASE WHEN ${newRev} THEN NULL ELSE approved_rev END
            WHERE item_id = ${item.id}`,
      );
      await db.execute(
        sql`UPDATE plugin_plans_items SET body = ${draftOf(raw)}, updated_at = NOW() WHERE id = ${item.id}`,
      );
      if (newRev && item.o_approved_rev !== null) {
        await log(
          plan,
          actor,
          surface,
          'send-approval-void',
          {
            why: 'the draft changed after Kohl approved it',
            approvedRev: Number(item.o_approved_rev),
          },
          { phaseId: item.phase_id, itemId: item.id },
        );
      }
    }

    /** Header lines a PATCH may set. Status and the approved/sent/edited/vetoed
     * stamps stay server-owned: send actions and draft edits write them. */
    const OUTREACH_FIELDS = ['to', 'room', 'why', 'steer'];
    /** Where it goes: changing these after Kohl's yes changes what that yes sent. */
    const MATERIAL_FIELDS = new Set(['to', 'room']);

    async function reviseHeader(
      plan: Plan,
      item: ItemRow,
      actor: Actor,
      surface: string,
      v: unknown,
    ): Promise<ItemRow> {
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        throw new PlanError('fields must be an object', 400);
      }
      const entries = Object.entries(v as Record<string, unknown>);
      const bad = entries.map(([k]) => k).filter((k) => !OUTREACH_FIELDS.includes(k));
      if (bad.length) {
        throw new PlanError(
          `fields can set only ${OUTREACH_FIELDS.join(', ')} (not ${bad.join(', ')})`,
          400,
        );
      }
      let raw = item.o_raw as string;
      const { meta } = split(raw);
      const changes: Record<string, { before: string | null; after: string }> = {};
      for (const [k, val] of entries) {
        const s = text(val, 'text').trim();
        // One header line, and no " #": queue.py would read the rest as a comment.
        if (/\n|\s#/.test(s)) throw new PlanError(`${k} must be one line without " #"`, 400);
        if ((meta[k] ?? null) === s) continue;
        raw = setFieldOf(raw, k, s);
        changes[k] = { before: meta[k] ?? null, after: s };
      }
      if (!Object.keys(changes).length) return item;
      const material = Object.keys(changes).some((k) => MATERIAL_FIELDS.has(k));
      const voids = material && meta.status === 'approved';
      if (voids) {
        // As queue.edit marks a draft changed after approval.
        for (const [k, val] of [
          ['status', 'edited'],
          ['edited', today()],
          ['edited_by', await queueName(plan, actor)],
        ]) {
          raw = setFieldOf(raw, k, val);
        }
      }
      await db.execute(
        sql`UPDATE plugin_plans_outreach SET raw = ${raw},
            approved_rev = CASE WHEN ${material} THEN NULL ELSE approved_rev END
            WHERE item_id = ${item.id}`,
      );
      await db.execute(sql`UPDATE plugin_plans_items SET updated_at = NOW() WHERE id = ${item.id}`);
      await log(
        plan,
        actor,
        surface,
        'outreach-fields',
        { changes },
        {
          phaseId: item.phase_id,
          itemId: item.id,
        },
      );
      if (material && (item.o_approved_rev !== null || voids)) {
        await log(
          plan,
          actor,
          surface,
          'send-approval-void',
          {
            why: 'where it goes changed after Kohl approved it',
            approvedRev: item.o_approved_rev === null ? null : Number(item.o_approved_rev),
            fields: Object.keys(changes).filter((k) => MATERIAL_FIELDS.has(k)),
          },
          { phaseId: item.phase_id, itemId: item.id },
        );
      }
      return (await itemFor(actor, item.id)).item;
    }

    async function reviseOutreach(
      plan: Plan,
      item: ItemRow,
      actor: Actor,
      surface: string,
      b: Record<string, unknown>,
    ) {
      if (b.kind !== undefined && b.kind !== 'outreach') {
        throw new PlanError('an outreach item stays outreach (decline it instead)', 400);
      }
      if (
        b.title !== undefined ||
        b.owner !== undefined ||
        b.phaseId !== undefined ||
        b.position !== undefined
      ) {
        // Title, owner, phase and order are the plan's business, not the draft's.
        const t = b.title !== undefined ? text(b.title, 'title', true) : item.title;
        const phaseId = b.phaseId !== undefined ? await phaseIn(plan, b.phaseId) : item.phase_id;
        const owner = b.owner !== undefined ? ownerOf(b.owner) : item.owner;
        const position =
          b.position !== undefined && Number.isInteger(b.position)
            ? (b.position as number)
            : Number(item.position);
        await db.execute(
          sql`UPDATE plugin_plans_items SET title = ${t}, phase_id = ${phaseId}, owner = ${owner},
              position = ${position}, updated_at = NOW() WHERE id = ${item.id}`,
        );
        await log(
          plan,
          actor,
          surface,
          'item-edited',
          {
            changes: { title: { before: item.title, after: t } },
          },
          { phaseId, itemId: item.id },
        );
      }
      if (b.fields !== undefined) item = await reviseHeader(plan, item, actor, surface, b.fields);
      if (b.body === undefined) return;
      const draft = text(b.body, 'body', true);
      const rev = Number(item.o_rev);
      const seenRev = b.seenRev === undefined ? rev : Number(b.seenRev);
      if (!Number.isInteger(seenRev) || seenRev < 1 || seenRev > rev) {
        throw new PlanError('seenRev must be a revision of this draft', 400);
      }
      // Kohl's TUI runs locally on RoboKohl's token: its edits are claimed
      // as Kohl's but unverified until the TUI has Kohl's credentials. Kohl
      // (2026-10-28): lessons count them. No flag ever picks the actor.
      const claimed = isAgent(actor) && b.claimed === 'kohl' ? 'kohl' : null;
      const by = claimed ?? (await queueName(plan, actor));
      let raw: string;
      try {
        raw = editDraft(item.o_raw as string, draft, by, today());
      } catch (e) {
        throw new PlanError((e as Error).message, 400);
      }
      if (claimed) raw = setFieldOf(raw, 'edited_unverified', 'true');
      if (raw === item.o_raw) return;
      const next = rev + 1;
      await addRevision(item.id, next, draftOf(raw), actor, surface, seenRev, causeOf(b), claimed);
      const kohl = await isKohl(plan, actor);
      const seen = kohl ? await revisionDraft(item.id, seenRev) : null;
      await saveOutreach(plan, item, actor, surface, raw, true);
      await log(
        plan,
        actor,
        surface,
        'outreach-revised',
        {
          rev: next,
          seenRev,
          before: item.body,
          after: draftOf(raw),
          // Kohl's red pen, against the text Kohl saw: the lesson.
          ...(seen !== null ? { kohlDiff: lineDiff(seen.trim(), draftOf(raw).trim()) } : {}),
          ...(causeOf(b) ? { causeMsg: causeOf(b) } : {}),
          ...(claimed ? { claimed, verified: false } : {}),
        },
        { phaseId: item.phase_id, itemId: item.id },
      );
    }

    // Kohl's decisions on a draft: approve it to send (that revision only),
    // veto it with a reason, or say it went out. Only the owner, as a person.
    fastify.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
      '/items/:id/send',
      async (request, reply) => {
        try {
          const actor = me(request);
          const { plan, item } = await itemFor(actor, request.params.id);
          const b = request.body ?? {};
          const surface = surfaceOf(request.headers, actor);
          if (item.kind !== 'outreach' || item.o_raw === null) {
            throw new PlanError('only outreach items are sent', 400);
          }
          if (!(await isKohl(plan, actor))) {
            throw new PlanError("only Kohl decides a send, from Kohl's own account", 403);
          }
          const action = b.action;
          const rev = Number(item.o_rev);
          const { meta } = split(item.o_raw);
          let raw: string;
          let detailOut: Record<string, unknown> = { rev, from: meta.status };
          let status: ItemStatus = item.status;
          if (action === 'approve') {
            if (Number(b.rev) !== rev) {
              throw new PlanError(
                'the draft changed since you read it: read it again, then approve',
                409,
              );
            }
            if (meta.status === 'sent') throw new PlanError('it already went out', 409);
            raw = decide(item.o_raw, 'approve', 'kohl', today());
            await db.execute(
              sql`UPDATE plugin_plans_outreach SET approved_rev = ${rev} WHERE item_id = ${item.id}`,
            );
            status = 'open';
          } else if (action === 'veto') {
            const reason = text(b.reason, 'text', true);
            raw = decide(item.o_raw, 'veto', 'kohl', today(), reason);
            await db.execute(
              sql`UPDATE plugin_plans_outreach SET approved_rev = NULL WHERE item_id = ${item.id}`,
            );
            detailOut = { ...detailOut, reason };
            status = 'declined';
          } else if (action === 'sent') {
            const outside = !(
              meta.status === 'approved' &&
              item.o_approved_rev !== null &&
              Number(item.o_approved_rev) === rev
            );
            raw = decide(item.o_raw, 'sent', 'kohl', today());
            if (outside) raw = setFieldOf(raw, 'sent_outside_queue', 'true');
            detailOut = { ...detailOut, outsideQueue: outside };
            status = 'done';
          } else if (action === 'hold') {
            // "Not now, leave it": nothing changes, approval included; the
            // event is the whole record (On-you shows it held until the next one).
            const note = b.note === undefined ? null : text(b.note, 'text');
            await log(
              plan,
              actor,
              surface,
              'send-hold',
              { rev, ...(note ? { note } : {}) },
              {
                phaseId: item.phase_id,
                itemId: item.id,
              },
            );
            return await detail(plan, actor);
          } else {
            throw new PlanError('action must be approve, veto, hold or sent', 400);
          }
          await saveOutreach(plan, item, actor, surface, raw, false);
          await db.execute(
            sql`UPDATE plugin_plans_items SET status = ${status} WHERE id = ${item.id}`,
          );
          await log(plan, actor, surface, `send-${action}`, detailOut, {
            phaseId: item.phase_id,
            itemId: item.id,
          });
          return await detail(plan, actor);
        } catch (err) {
          return fail(reply, err);
        }
      },
    );

    fastify.get<{ Params: { id: string } }>('/items/:id/revisions', async (request, reply) => {
      try {
        const actor = me(request);
        const { item } = await itemFor(actor, request.params.id);
        const rows = (await db.execute(
          sql`SELECT rev, draft, actor_name, surface, seen_rev, cause_msg, verified, claimed, at
              FROM plugin_plans_revisions WHERE item_id = ${item.id} ORDER BY rev`,
        )) as unknown as {
          rev: number;
          draft: string;
          actor_name: string;
          surface: string;
          seen_rev: number | null;
          cause_msg: string | null;
          verified: boolean;
          claimed: string | null;
          at: string | Date;
        }[];
        return rows.map((r) => ({
          rev: Number(r.rev),
          draft: r.draft,
          by: r.actor_name,
          surface: r.surface,
          seenRev: r.seen_rev === null ? null : Number(r.seen_rev),
          causeMsg: r.cause_msg,
          verified: r.verified,
          claimed: r.claimed,
          at: iso(r.at),
        }));
      } catch (err) {
        return fail(reply, err);
      }
    });

    fastify.post<{ Params: { id: string }; Body: { status?: unknown; resolution?: unknown } }>(
      '/items/:id/status',
      async (request, reply) => {
        try {
          const actor = me(request);
          const { plan, item } = await itemFor(actor, request.params.id);
          const status = request.body?.status;
          if (!['open', 'in_progress', 'done', 'declined'].includes(status as string)) {
            throw new PlanError('status must be open, in_progress, done or declined', 400);
          }
          const resolution = text(request.body?.resolution, 'text', status === 'done');
          if (status === 'in_progress' && item.kind === 'build') {
            const rows = (await db.execute(
              sql`SELECT status FROM plugin_plans_phases WHERE id = ${item.phase_id}`,
            )) as unknown as { status: PhaseStatus }[];
            if (rows[0]?.status !== 'approved') {
              throw new PlanError('build work starts once its phase is approved', 409);
            }
          }
          await db.execute(
            sql`UPDATE plugin_plans_items SET status = ${status as string},
                resolution = ${resolution || item.resolution}, updated_at = NOW() WHERE id = ${item.id}`,
          );
          await log(
            plan,
            actor,
            surfaceOf(request.headers, actor),
            'item-status',
            { before: item.status, after: status, ...(resolution ? { resolution } : {}) },
            { phaseId: item.phase_id, itemId: item.id },
          );
          return await detail(plan, actor);
        } catch (err) {
          return fail(reply, err);
        }
      },
    );

    // ── the record ─────────────────────────────────────────────────────

    fastify.post<{
      Params: { slug: string };
      Body: { body?: unknown; phaseId?: unknown; itemId?: unknown };
    }>('/plans/:slug/comments', async (request, reply) => {
      try {
        const actor = me(request);
        const plan = await planFor(actor, request.params.slug);
        const body = text(request.body?.body, 'text', true);
        const phaseId = await phaseIn(plan, request.body?.phaseId);
        let itemId: string | null = null;
        if (request.body?.itemId !== undefined) {
          const { item } = await itemFor(actor, String(request.body.itemId));
          if (item.plan_id !== plan.id)
            throw new PlanError('itemId must be an item of this plan', 400);
          itemId = item.id;
        }
        await log(
          plan,
          actor,
          surfaceOf(request.headers, actor),
          'comment',
          { body },
          {
            phaseId,
            itemId,
          },
        );
        return reply.status(201).send({ ok: true });
      } catch (err) {
        return fail(reply, err);
      }
    });

    // Outreach items across every plan the caller can see; ?ref=0017 for one.
    fastify.get<{ Querystring: { ref?: string } }>('/outreach', async (request, reply) => {
      try {
        const actor = me(request);
        const { ref } = request.query;
        if (ref !== undefined && !/^\d{4}$/.test(ref)) {
          throw new PlanError('ref must be four digits', 400);
        }
        const rows = (await db.execute(
          ref !== undefined
            ? sql`${ITEM_SELECT} WHERE o.ref = ${ref}`
            : sql`${ITEM_SELECT} WHERE o.item_id IS NOT NULL ORDER BY o.ref NULLS LAST, i.created_at`,
        )) as unknown as ItemRow[];
        const plans = new Map<string, Plan | null>();
        const out: (PlanItem & { planSlug: string })[] = [];
        for (const r of rows) {
          if (!plans.has(r.plan_id)) {
            plans.set(
              r.plan_id,
              await planById(actor, r.plan_id).catch((e) => {
                if (e instanceof PlanError) return null;
                throw e;
              }),
            );
          }
          const plan = plans.get(r.plan_id);
          if (plan) out.push({ ...toItem(r), planSlug: plan.slug });
        }
        if (ref !== undefined && !out.length)
          throw new PlanError('no outreach item with that ref', 404);
        return out;
      } catch (err) {
        return fail(reply, err);
      }
    });

    // Every plan's events the caller can see, one cursor: seq is global.
    // `cursor` is the last seq read, shown or not, so a poller never rereads.
    fastify.get<{ Querystring: { after?: string } }>('/events', async (request, reply) => {
      try {
        const actor = me(request);
        const after = Number.parseInt(request.query.after ?? '0', 10) || 0;
        const rows = (await db.execute(
          sql`SELECT e.*, p.slug AS plan_slug, p.server_id AS server_id
              FROM plugin_plans_events e JOIN plugin_plans_plans p ON p.id = e.plan_id
              WHERE e.seq > ${after} ORDER BY e.seq LIMIT 1000`,
        )) as unknown as (EventRow & { plan_slug: string; server_id: string })[];
        const member = new Map<string, boolean>();
        const events: (PlanEvent & { planSlug: string })[] = [];
        for (const r of rows) {
          if (!member.has(r.server_id)) {
            member.set(r.server_id, await canAccess(fastify, actor, r.server_id));
          }
          if (!member.get(r.server_id)) continue;
          events.push({
            seq: Number(r.seq),
            planSlug: r.plan_slug,
            phaseId: r.phase_id,
            itemId: r.item_id,
            actor: { id: r.actor_id, name: r.actor_name },
            surface: r.surface,
            action: r.action,
            detail: json<Record<string, unknown>>(r.detail),
            at: iso(r.at),
          });
        }
        const cursor = rows.length ? Number(rows[rows.length - 1].seq) : after;
        return { events, cursor };
      } catch (err) {
        return fail(reply, err);
      }
    });

    fastify.get<{ Params: { slug: string }; Querystring: { after?: string } }>(
      '/plans/:slug/events',
      async (request, reply) => {
        try {
          const actor = me(request);
          const plan = await planFor(actor, request.params.slug);
          const after = Number.parseInt(request.query.after ?? '0', 10) || 0;
          const rows = (await db.execute(
            sql`SELECT * FROM plugin_plans_events WHERE plan_id = ${plan.id} AND seq > ${after}
                ORDER BY seq LIMIT 1000`,
          )) as unknown as EventRow[];
          return rows.map(
            (r): PlanEvent => ({
              seq: Number(r.seq),
              phaseId: r.phase_id,
              itemId: r.item_id,
              actor: { id: r.actor_id, name: r.actor_name },
              surface: r.surface,
              action: r.action,
              detail: json<Record<string, unknown>>(r.detail),
              at: iso(r.at),
            }),
          );
        } catch (err) {
          return fail(reply, err);
        }
      },
    );
  },
});
