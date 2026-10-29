// SPDX-License-Identifier: MIT
import { definePlugin, canAccess, canManage, requireMember } from '@babelr/plugin-sdk';
import type { PluginInboxHandler } from '@babelr/plugin-sdk';
import { sql } from 'drizzle-orm';

/**
 * Project Management — second first-party plugin, validating the SDK
 * at complex scale. Built bottom-up over several tasks (see
 * gameplan.json: plugin-phase-4). This commit delivers task-pm-1:
 * schema migrations + basic server CRUD. Later tasks add the kanban
 * UI, drag-and-drop, comments via useChat, task/board embeds, real-
 * time sync, and AS2-object federation.
 *
 * Data model:
 *   - boards: top-level kanban surfaces scoped to a server (Group).
 *     Each board gets three seed columns (Todo / In Progress / Done)
 *     at creation; custom columns come in a later task.
 *   - columns: ordered lanes within a board, optional WIP limit.
 *   - work_items: the cards users drag around. priority +
 *     item_type ('task' | 'bug' | 'story' | 'epic') + optional
 *     assignee / story points / due date. slug is a 10-char token
 *     used in [[task:slug]] embeds.
 *   - Sprints (plugin-phase-4 deferred) and per-board permissions
 *     (deferred) are not in this shape yet.
 *
 * Access: every route needs a login (the loader enforces it), and
 * every board, its columns and its work items are visible only to
 * members of the board's server. Non-members get 404 for reads and
 * writes alike. Within a server, any member can create boards and
 * work items and move cards (reorder, or a PATCH that only changes
 * columnId/position). Changing a work item's content (title,
 * description, priority, type, assignee, points, due date) or
 * deleting it is for its reporter or a server admin (MANAGE_SERVER);
 * other members get 403. Boards have no edit or delete route yet.
 *
 * Comments will attach via a chat_id pointing at an OrderedCollection
 * in the core objects table — same pattern wiki / events / files use.
 * Not wired in this commit; arrives in task-pm-5.
 */

interface BoardRow {
  id: string;
  slug: string;
  server_id: string;
  name: string;
  description: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface ColumnRow {
  id: string;
  board_id: string;
  position: number;
  name: string;
  wip_limit: number | null;
}

interface WorkItemRow {
  id: string;
  board_id: string;
  column_id: string;
  slug: string;
  title: string;
  description: string | null;
  priority: string;
  item_type: string;
  reporter_id: string;
  assignee_id: string | null;
  story_points: number | null;
  due_date: string | null;
  position: number;
  chat_id: string | null;
  created_at: string;
  updated_at: string;
}

interface BoardSummary {
  slug: string;
  name: string;
  description: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  workItemCount: number;
}

interface BoardDetail extends BoardSummary {
  columns: ColumnView[];
}

interface ColumnView {
  id: string;
  position: number;
  name: string;
  wipLimit: number | null;
  workItems: WorkItemView[];
}

interface WorkItemView {
  slug: string;
  title: string;
  description: string | null;
  priority: string;
  itemType: string;
  reporterId: string;
  assigneeId: string | null;
  storyPoints: number | null;
  dueDate: string | null;
  position: number;
  columnId: string;
  /** OrderedCollection id this item's comment thread lives in.
   *  Null for legacy rows that predated comments support; creates
   *  populate it eagerly. */
  chatId: string | null;
  createdAt: string;
  updatedAt: string;
}

function randomSlug(): string {
  return Math.random().toString(36).slice(2, 12);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type InboxCtx = Parameters<NonNullable<PluginInboxHandler['handleDelete']>>[0];

/** May this federated actor write to boards of `serverId`? It must be
 *  a member of that server, or the server's own Group actor. */
async function remoteMayWrite(ctx: InboxCtx, serverId: string): Promise<boolean> {
  if (ctx.remoteActor.id === serverId) return true;
  return canAccess(ctx.fastify, ctx.remoteActor, serverId);
}

/** The work item `slug`, if the federated actor reported it and may
 *  still write to its board's server; otherwise null. */
async function remoteOwnedItem(
  ctx: InboxCtx,
  slug: string,
): Promise<{ id: string; chat_id: string | null; server_id: string; board_slug: string } | null> {
  const rows = (await ctx.fastify.db.execute(
    sql`SELECT w.id, w.chat_id, w.reporter_id, b.server_id, b.slug AS board_slug
          FROM plugin_pm_work_items w
          JOIN plugin_pm_boards b ON b.id = w.board_id
         WHERE w.slug = ${slug}
         LIMIT 1`,
  )) as unknown as {
    id: string;
    chat_id: string | null;
    reporter_id: string;
    server_id: string;
    board_slug: string;
  }[];
  const item = rows[0];
  if (!item || item.reporter_id !== ctx.remoteActor.id) return null;
  if (!(await remoteMayWrite(ctx, item.server_id))) return null;
  return item;
}

/** Tell the board's server members (only) that an item changed. */
function broadcastToBoard(ctx: InboxCtx, serverId: string, boardSlug: string, slug: string) {
  void ctx.fastify.broadcastToServerMembers(serverId, {
    type: 'plugin:pm:updated' as never,
    payload: { boardSlug, kind: 'work-item', slug } as never,
  });
}

/** PATCH fields that change what a work item says, as opposed to
 *  where it sits on the board. Only the reporter or an admin may
 *  change these. */
const CONTENT_FIELDS = [
  'title',
  'description',
  'priority',
  'itemType',
  'assigneeId',
  'storyPoints',
  'dueDate',
] as const;

export default definePlugin({
  id: 'project-management',
  name: 'Project Management',
  version: '0.1.0',
  description:
    'Kanban boards, work items, and sprints — shared workspace surface with the full translation + federation pipeline.',
  dependencies: { babelr: '^0.1.0' },

  migrations: [
    {
      id: 1,
      name: 'init',
      up: `
        CREATE TABLE IF NOT EXISTS plugin_pm_boards (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          slug TEXT NOT NULL UNIQUE,
          server_id UUID NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          created_by UUID NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS plugin_pm_boards_server_idx ON plugin_pm_boards (server_id);

        CREATE TABLE IF NOT EXISTS plugin_pm_columns (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          board_id UUID NOT NULL REFERENCES plugin_pm_boards(id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          name TEXT NOT NULL,
          wip_limit INTEGER
        );
        CREATE INDEX IF NOT EXISTS plugin_pm_columns_board_idx ON plugin_pm_columns (board_id, position);

        CREATE TABLE IF NOT EXISTS plugin_pm_work_items (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          board_id UUID NOT NULL REFERENCES plugin_pm_boards(id) ON DELETE CASCADE,
          column_id UUID NOT NULL REFERENCES plugin_pm_columns(id) ON DELETE CASCADE,
          slug TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          description TEXT,
          priority TEXT NOT NULL DEFAULT 'medium',
          item_type TEXT NOT NULL DEFAULT 'task',
          reporter_id UUID NOT NULL,
          assignee_id UUID,
          story_points INTEGER,
          due_date TIMESTAMPTZ,
          position INTEGER NOT NULL DEFAULT 0,
          chat_id UUID,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS plugin_pm_work_items_board_idx ON plugin_pm_work_items (board_id);
        CREATE INDEX IF NOT EXISTS plugin_pm_work_items_column_idx ON plugin_pm_work_items (column_id, position);
      `,
    },
  ],

  serverRoutes: async (fastify) => {
    /** Resolve the Group actor URI for a board's server_id. */
    async function getGroupUri(boardId: string): Promise<{
      serverId: string;
      groupUri: string;
    } | null> {
      const boards = (await fastify.db.execute(
        sql`SELECT server_id FROM plugin_pm_boards WHERE id = ${boardId} LIMIT 1`,
      )) as unknown as { server_id: string }[];
      if (!boards[0]) return null;
      const groups = (await fastify.db.execute(
        sql`SELECT id, uri FROM actors WHERE id = ${boards[0].server_id} AND local = true LIMIT 1`,
      )) as unknown as { id: string; uri: string }[];
      if (!groups[0]) return null;
      return { serverId: groups[0].id, groupUri: groups[0].uri };
    }

    /** Build an AS2 WorkItem object from a row. Multi-typed so AP-
     *  unaware servers degrade to seeing a Note. */
    function buildWorkItemObject(item: WorkItemRow, origin: string): Record<string, unknown> {
      return {
        '@context': 'https://www.w3.org/ns/activitystreams',
        type: ['Note', 'WorkItem'],
        id: `${origin}/plugins/project-management/tasks/${item.slug}`,
        attributedTo: item.reporter_id,
        content: item.title,
        source: {
          content: item.description ?? '',
          mediaType: 'text/plain',
        },
        'babelr:priority': item.priority,
        'babelr:itemType': item.item_type,
        'babelr:boardId': item.board_id,
        'babelr:columnId': item.column_id,
        'babelr:slug': item.slug,
        published: item.created_at,
        updated: item.updated_at,
      };
    }

    async function deliverWorkItem(
      activityType: 'Create' | 'Update' | 'Delete',
      item: WorkItemRow,
    ) {
      const group = await getGroupUri(item.board_id);
      if (!group) return;
      const protocol = fastify.config.secureCookies ? 'https' : 'http';
      const origin = `${protocol}://${fastify.config.domain}`;
      const activity: Record<string, unknown> =
        activityType === 'Delete'
          ? {
              '@context': 'https://www.w3.org/ns/activitystreams',
              type: 'Delete',
              actor: group.groupUri,
              object: `${origin}/plugins/project-management/tasks/${item.slug}`,
              published: new Date().toISOString(),
            }
          : {
              '@context': 'https://www.w3.org/ns/activitystreams',
              type: activityType,
              actor: group.groupUri,
              object: buildWorkItemObject(item, origin),
              published: new Date().toISOString(),
            };
      await fastify.deliverToGroupFollowers(group.serverId, activity);
    }

    /** Plugin-scoped WS broadcast. Payload carries the board slug so
     *  subscribed clients can decide whether to refetch. Follows the
     *  polls plugin's pattern — opaque type pass-through, clients
     *  filter by the event string. */
    function broadcastPm(
      serverId: string,
      boardSlug: string,
      kind: 'work-item' | 'reorder' | 'board',
      slug?: string,
    ) {
      // Members of the board's server only: even the slugs are theirs.
      void fastify.broadcastToServerMembers(serverId, {
        type: 'plugin:pm:updated' as never,
        payload: { boardSlug, kind, slug } as never,
      });
    }

    async function boardBySlug(slug: string): Promise<BoardRow | null> {
      const rows = (await fastify.db.execute(
        sql`SELECT * FROM plugin_pm_boards WHERE slug = ${slug} LIMIT 1`,
      )) as unknown as BoardRow[];
      return rows[0] ?? null;
    }

    /** A work item plus its board's server and slug, for access checks. */
    async function itemBySlug(
      slug: string,
    ): Promise<(WorkItemRow & { server_id: string; board_slug: string }) | null> {
      const rows = (await fastify.db.execute(
        sql`SELECT w.*, b.server_id, b.slug AS board_slug
              FROM plugin_pm_work_items w
              JOIN plugin_pm_boards b ON b.id = w.board_id
             WHERE w.slug = ${slug}
             LIMIT 1`,
      )) as unknown as (WorkItemRow & { server_id: string; board_slug: string })[];
      return rows[0] ?? null;
    }

    async function loadBoardDetail(slug: string): Promise<BoardDetail | null> {
      const boards = (await fastify.db.execute(
        sql`SELECT * FROM plugin_pm_boards WHERE slug = ${slug} LIMIT 1`,
      )) as unknown as BoardRow[];
      const board = boards[0];
      if (!board) return null;

      const columns = (await fastify.db.execute(
        sql`SELECT * FROM plugin_pm_columns WHERE board_id = ${board.id} ORDER BY position`,
      )) as unknown as ColumnRow[];

      const items = (await fastify.db.execute(
        sql`SELECT * FROM plugin_pm_work_items
            WHERE board_id = ${board.id}
            ORDER BY column_id, position`,
      )) as unknown as WorkItemRow[];

      const itemsByColumn = new Map<string, WorkItemView[]>();
      for (const i of items) {
        const view: WorkItemView = {
          slug: i.slug,
          title: i.title,
          description: i.description,
          priority: i.priority,
          itemType: i.item_type,
          reporterId: i.reporter_id,
          assigneeId: i.assignee_id,
          storyPoints: i.story_points,
          dueDate: i.due_date,
          position: i.position,
          columnId: i.column_id,
          chatId: i.chat_id,
          createdAt: i.created_at,
          updatedAt: i.updated_at,
        };
        const bucket = itemsByColumn.get(i.column_id) ?? [];
        bucket.push(view);
        itemsByColumn.set(i.column_id, bucket);
      }

      return {
        slug: board.slug,
        name: board.name,
        description: board.description,
        createdBy: board.created_by,
        createdAt: board.created_at,
        updatedAt: board.updated_at,
        workItemCount: items.length,
        columns: columns.map((c) => ({
          id: c.id,
          position: c.position,
          name: c.name,
          wipLimit: c.wip_limit,
          workItems: itemsByColumn.get(c.id) ?? [],
        })),
      };
    }

    // --- Boards ---

    fastify.post<{
      Body: { serverId: string; name: string; description?: string };
    }>('/boards', async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
      const { serverId, name, description } = request.body ?? {};
      if (!serverId || !name?.trim()) {
        return reply.status(400).send({ error: 'serverId and name are required' });
      }
      if (!(await requireMember(request, reply, serverId))) return reply;
      const boardSlug = randomSlug();
      const actorId = request.actor.id;
      const inserted = (await fastify.db.execute(
        sql`INSERT INTO plugin_pm_boards (slug, server_id, name, description, created_by)
            VALUES (${boardSlug}, ${serverId}, ${name.trim()}, ${description ?? null}, ${actorId})
            RETURNING id`,
      )) as unknown as { id: string }[];
      const boardId = inserted[0].id;

      // Seed three default columns. Custom columns come later; WIP
      // limits left unset so the initial board is frictionless.
      const seeds = [
        { position: 0, name: 'Todo' },
        { position: 1, name: 'In Progress' },
        { position: 2, name: 'Done' },
      ];
      for (const c of seeds) {
        await fastify.db.execute(
          sql`INSERT INTO plugin_pm_columns (board_id, position, name)
              VALUES (${boardId}, ${c.position}, ${c.name})`,
        );
      }

      const detail = await loadBoardDetail(boardSlug);
      broadcastPm(serverId, boardSlug, 'board');
      return detail;
    });

    fastify.get<{ Querystring: { serverId?: string } }>('/boards', async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
      const { serverId } = request.query;
      if (!serverId) {
        return reply.status(400).send({ error: 'serverId query param is required' });
      }
      if (!(await requireMember(request, reply, serverId))) return reply;
      const rows = (await fastify.db.execute(
        sql`SELECT b.*,
                     (SELECT COUNT(*) FROM plugin_pm_work_items w WHERE w.board_id = b.id)
                       AS work_item_count
              FROM plugin_pm_boards b
              WHERE server_id = ${serverId}
              ORDER BY updated_at DESC`,
      )) as unknown as (BoardRow & { work_item_count: string })[];
      return rows.map<BoardSummary>((b) => ({
        slug: b.slug,
        name: b.name,
        description: b.description,
        createdBy: b.created_by,
        createdAt: b.created_at,
        updatedAt: b.updated_at,
        workItemCount: Number(b.work_item_count),
      }));
    });

    fastify.get<{ Params: { slug: string } }>('/boards/:slug', async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
      const board = await boardBySlug(request.params.slug);
      if (!board || !(await canAccess(fastify, request.actor, board.server_id))) {
        return reply.status(404).send({ error: 'Board not found' });
      }
      const detail = await loadBoardDetail(request.params.slug);
      if (!detail) return reply.status(404).send({ error: 'Board not found' });
      return detail;
    });

    // --- Work items ---

    fastify.post<{
      Params: { slug: string };
      Body: {
        columnId: string;
        title: string;
        description?: string;
        priority?: string;
        itemType?: string;
        assigneeId?: string | null;
        storyPoints?: number | null;
        dueDate?: string | null;
      };
    }>('/boards/:slug/work-items', async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
      const body = request.body ?? ({} as typeof request.body);
      const { columnId, title, description, priority, itemType, assigneeId, storyPoints, dueDate } =
        body;
      if (!columnId || !title?.trim()) {
        return reply.status(400).send({ error: 'columnId and title are required' });
      }
      const board = await boardBySlug(request.params.slug);
      if (!board || !(await canAccess(fastify, request.actor, board.server_id))) {
        return reply.status(404).send({ error: 'Board not found' });
      }

      // Confirm the column belongs to this board.
      const cols = (await fastify.db.execute(
        sql`SELECT id FROM plugin_pm_columns WHERE id = ${columnId} AND board_id = ${board.id}`,
      )) as unknown as { id: string }[];
      if (cols.length === 0) {
        return reply.status(400).send({ error: 'columnId does not belong to this board' });
      }

      // Position at the end of the column — max(position) + 1.
      const maxRows = (await fastify.db.execute(
        sql`SELECT COALESCE(MAX(position), -1) AS max_pos
            FROM plugin_pm_work_items
            WHERE column_id = ${columnId}`,
      )) as unknown as { max_pos: number }[];
      const position = Number(maxRows[0].max_pos) + 1;

      const itemSlug = randomSlug();
      const actorId = request.actor.id;

      // Create the per-item OrderedCollection that backs the comment
      // thread. Mirrors how events/files do it — useChat(actor, chatId)
      // on the client then gets full message infra (translation,
      // reactions, threading) for free. URI is stable + discoverable
      // so federation can resolve it later.
      const origin = `${request.protocol}://${request.hostname}`;
      const chatUri = `${origin}/plugins/project-management/tasks/${itemSlug}/chat`;
      const chatProps = JSON.stringify({
        name: title.trim(),
        isTaskChat: true,
        taskSlug: itemSlug,
      });
      const chatRows = (await fastify.db.execute(
        sql`INSERT INTO objects (uri, type, belongs_to, properties)
            VALUES (${chatUri}, 'OrderedCollection', NULL, ${chatProps}::jsonb)
            RETURNING id`,
      )) as unknown as { id: string }[];
      const chatId = chatRows[0].id;

      const inserted = (await fastify.db.execute(
        sql`INSERT INTO plugin_pm_work_items
              (board_id, column_id, slug, title, description, priority, item_type,
               reporter_id, assignee_id, story_points, due_date, position, chat_id)
            VALUES
              (${board.id}, ${columnId}, ${itemSlug}, ${title.trim()},
               ${description ?? null}, ${priority ?? 'medium'}, ${itemType ?? 'task'},
               ${actorId}, ${assigneeId ?? null}, ${storyPoints ?? null}, ${dueDate ?? null},
               ${position}, ${chatId})
            RETURNING *`,
      )) as unknown as WorkItemRow[];
      const item = inserted[0];
      broadcastPm(board.server_id, request.params.slug, 'work-item', item.slug);
      void deliverWorkItem('Create', item);
      return {
        slug: item.slug,
        title: item.title,
        description: item.description,
        priority: item.priority,
        itemType: item.item_type,
        reporterId: item.reporter_id,
        assigneeId: item.assignee_id,
        storyPoints: item.story_points,
        dueDate: item.due_date,
        position: item.position,
        columnId: item.column_id,
        chatId: item.chat_id,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
      } satisfies WorkItemView;
    });

    fastify.get<{ Params: { slug: string } }>('/work-items/:slug', async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
      const i = await itemBySlug(request.params.slug);
      if (!i || !(await canAccess(fastify, request.actor, i.server_id))) {
        return reply.status(404).send({ error: 'Work item not found' });
      }
      return {
        slug: i.slug,
        title: i.title,
        description: i.description,
        priority: i.priority,
        itemType: i.item_type,
        reporterId: i.reporter_id,
        assigneeId: i.assignee_id,
        storyPoints: i.story_points,
        dueDate: i.due_date,
        position: i.position,
        columnId: i.column_id,
        chatId: i.chat_id,
        createdAt: i.created_at,
        updatedAt: i.updated_at,
      } satisfies WorkItemView;
    });

    // Bulk reorder endpoint — drop targets produce a new ordered
    // itemIds list per affected column (at most two columns per drop,
    // one when the drop is same-column). Server validates every id
    // belongs to the board, then rewrites positions sequentially.
    // Simpler + more robust than fractional-position math for a
    // surface where drops are low-frequency and column sizes are
    // small.
    fastify.post<{
      Params: { slug: string };
      Body: { assignments: Array<{ columnId: string; itemIds: string[] }> };
    }>('/boards/:slug/reorder', async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
      const { assignments } = request.body ?? { assignments: [] };
      if (!Array.isArray(assignments) || assignments.length === 0) {
        return reply.status(400).send({ error: 'assignments required' });
      }
      const board = await boardBySlug(request.params.slug);
      if (!board || !(await canAccess(fastify, request.actor, board.server_id))) {
        return reply.status(404).send({ error: 'Board not found' });
      }

      // itemIds are work-item slugs (what the client holds). Server
      // resolves slug → row id below; a single SELECT ... IN makes the
      // validation one round-trip instead of per-item.
      const columnIds = assignments.map((a) => a.columnId);
      const itemSlugs = assignments.flatMap((a) => a.itemIds);

      const cols = (await fastify.db.execute(
        sql`SELECT id FROM plugin_pm_columns
            WHERE board_id = ${board.id} AND id IN ${columnIds}`,
      )) as unknown as { id: string }[];
      if (cols.length !== columnIds.length) {
        return reply.status(400).send({ error: 'columnId not on this board' });
      }
      if (itemSlugs.length > 0) {
        const items = (await fastify.db.execute(
          sql`SELECT slug FROM plugin_pm_work_items
              WHERE board_id = ${board.id} AND slug IN ${itemSlugs}`,
        )) as unknown as { slug: string }[];
        if (items.length !== itemSlugs.length) {
          return reply.status(400).send({ error: 'workItem not on this board' });
        }
      }

      for (const { columnId, itemIds: ordered } of assignments) {
        for (let i = 0; i < ordered.length; i++) {
          await fastify.db.execute(
            sql`UPDATE plugin_pm_work_items
                SET column_id = ${columnId}, position = ${i}, updated_at = NOW()
                WHERE slug = ${ordered[i]} AND board_id = ${board.id}`,
          );
        }
      }
      broadcastPm(board.server_id, request.params.slug, 'reorder');
      return reply.status(204).send();
    });

    fastify.patch<{
      Params: { slug: string };
      Body: Partial<{
        columnId: string;
        position: number;
        title: string;
        description: string | null;
        priority: string;
        itemType: string;
        assigneeId: string | null;
        storyPoints: number | null;
        dueDate: string | null;
      }>;
    }>('/work-items/:slug', async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
      const body = request.body ?? {};
      const current = await itemBySlug(request.params.slug);
      if (!current || !(await canAccess(fastify, request.actor, current.server_id))) {
        return reply.status(404).send({ error: 'Work item not found' });
      }
      // Any member can move a card; changing what it says is for its
      // reporter or a server admin.
      const editsContent = CONTENT_FIELDS.some((f) => body[f] !== undefined);
      if (
        editsContent &&
        !(await canManage(fastify, request.actor, current.server_id, current.reporter_id))
      ) {
        return reply
          .status(403)
          .send({ error: 'Only the reporter or a server admin can edit this work item' });
      }

      // Merge provided fields with current values; let the DB settle
      // updated_at. The SQL builder approach keeps this readable for
      // the modest number of optional fields here; larger surfaces
      // would want the plugin DB abstraction (roadmap item).
      const nextColumnId = body.columnId ?? current.column_id;
      const nextPosition = body.position ?? current.position;
      const nextTitle = body.title ?? current.title;
      const nextDescription =
        body.description !== undefined ? body.description : current.description;
      const nextPriority = body.priority ?? current.priority;
      const nextItemType = body.itemType ?? current.item_type;
      const nextAssignee = body.assigneeId !== undefined ? body.assigneeId : current.assignee_id;
      const nextStoryPoints =
        body.storyPoints !== undefined ? body.storyPoints : current.story_points;
      const nextDueDate = body.dueDate !== undefined ? body.dueDate : current.due_date;

      if (body.columnId && body.columnId !== current.column_id) {
        // Cross-column move — verify destination belongs to the same board.
        const check = (await fastify.db.execute(
          sql`SELECT id FROM plugin_pm_columns WHERE id = ${body.columnId} AND board_id = ${current.board_id}`,
        )) as unknown as { id: string }[];
        if (check.length === 0) {
          return reply.status(400).send({ error: 'columnId does not belong to this board' });
        }
      }

      const updated = (await fastify.db.execute(
        sql`UPDATE plugin_pm_work_items
            SET column_id = ${nextColumnId},
                position = ${nextPosition},
                title = ${nextTitle},
                description = ${nextDescription},
                priority = ${nextPriority},
                item_type = ${nextItemType},
                assignee_id = ${nextAssignee},
                story_points = ${nextStoryPoints},
                due_date = ${nextDueDate},
                updated_at = NOW()
            WHERE id = ${current.id}
            RETURNING *`,
      )) as unknown as WorkItemRow[];
      const item = updated[0];
      broadcastPm(current.server_id, current.board_slug, 'work-item', item.slug);
      void deliverWorkItem('Update', item);
      return {
        slug: item.slug,
        title: item.title,
        description: item.description,
        priority: item.priority,
        itemType: item.item_type,
        reporterId: item.reporter_id,
        assigneeId: item.assignee_id,
        storyPoints: item.story_points,
        dueDate: item.due_date,
        position: item.position,
        columnId: item.column_id,
        chatId: item.chat_id,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
      } satisfies WorkItemView;
    });

    fastify.delete<{ Params: { slug: string } }>('/work-items/:slug', async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
      // Fetch full row before deleting so we can construct the AS2
      // Delete activity with proper context.
      const toDelete = await itemBySlug(request.params.slug);
      if (!toDelete || !(await canAccess(fastify, request.actor, toDelete.server_id))) {
        return reply.status(404).send({ error: 'Work item not found' });
      }
      if (!(await canManage(fastify, request.actor, toDelete.server_id, toDelete.reporter_id))) {
        return reply
          .status(403)
          .send({ error: 'Only the reporter or a server admin can delete this work item' });
      }
      const res = (await fastify.db.execute(
        sql`DELETE FROM plugin_pm_work_items WHERE id = ${toDelete.id}
              RETURNING id, chat_id, board_id`,
      )) as unknown as {
        id: string;
        chat_id: string | null;
        board_id: string;
      }[];
      if (res.length === 0) return reply.status(404).send({ error: 'Work item not found' });
      // Drop the comment thread too. Any child messages cascade via
      // the objects.in_reply_to / context FKs in the core schema.
      const chatId = res[0].chat_id;
      if (chatId) {
        await fastify.db.execute(sql`DELETE FROM objects WHERE id = ${chatId}`);
      }
      broadcastPm(toDelete.server_id, toDelete.board_slug, 'work-item', request.params.slug);
      void deliverWorkItem('Delete', toDelete);
      return reply.status(204).send();
    });
  },

  // Federated writes. The inbox has already verified the HTTP
  // Signature and that the activity's actor is the signer; these
  // handlers decide whether that actor may write. The rules mirror the
  // HTTP routes: the actor must belong to the board's server (be a
  // member, or be that server's own Group actor, which is who
  // deliverWorkItem sends as), and only an item's reporter may update
  // or delete it. Anything else is dropped without a trace.
  inboxHandlers: {
    WorkItem: {
      handleCreate: async (ctx, objData) => {
        const boardId = objData['babelr:boardId'] as string | undefined;
        const slug = objData['babelr:slug'] as string | undefined;
        if (typeof boardId !== 'string' || !UUID_RE.test(boardId)) return;
        if (typeof slug !== 'string' || !slug) return;

        // Verify the board exists on this tower.
        const boards = (await ctx.fastify.db.execute(
          sql`SELECT id, slug, server_id FROM plugin_pm_boards WHERE id = ${boardId} LIMIT 1`,
        )) as unknown as { id: string; slug: string; server_id: string }[];
        const board = boards[0];
        if (!board) return;
        if (!(await remoteMayWrite(ctx, board.server_id))) return;

        const columnId = objData['babelr:columnId'] as string | undefined;
        const title = (objData.content as string) ?? '';
        const source = objData.source as { content?: string } | undefined;
        const description = source?.content || null;
        const priority = (objData['babelr:priority'] as string) ?? 'medium';
        const itemType = (objData['babelr:itemType'] as string) ?? 'task';

        // Upsert — the same work item may arrive more than once via
        // Group-relay redelivery. A redelivery may refresh the item,
        // but a Create can never take over a slug that belongs to
        // another board or another reporter.
        await ctx.fastify.db.execute(
          sql`INSERT INTO plugin_pm_work_items
                (board_id, column_id, slug, title, description, priority,
                 item_type, reporter_id, position)
              VALUES
                (${boardId}, ${columnId ?? boardId}, ${slug}, ${title},
                 ${description}, ${priority}, ${itemType},
                 ${ctx.remoteActor.id}, 0)
              ON CONFLICT (slug) DO UPDATE
                SET title = EXCLUDED.title,
                    description = EXCLUDED.description,
                    priority = EXCLUDED.priority,
                    item_type = EXCLUDED.item_type,
                    updated_at = NOW()
                WHERE plugin_pm_work_items.board_id = EXCLUDED.board_id
                  AND plugin_pm_work_items.reporter_id = EXCLUDED.reporter_id`,
        );

        broadcastToBoard(ctx, board.server_id, board.slug, slug);
        ctx.fastify.log.info({ slug }, 'Remote Create(WorkItem) processed');
      },

      handleUpdate: async (ctx, objData) => {
        const slug = objData['babelr:slug'] as string | undefined;
        if (typeof slug !== 'string' || !slug) return;
        const item = await remoteOwnedItem(ctx, slug);
        if (!item) return;

        const title = (objData.content as string) ?? undefined;
        const source = objData.source as { content?: string } | undefined;
        const description = source?.content ?? undefined;
        const priority = (objData['babelr:priority'] as string) ?? undefined;
        const itemType = (objData['babelr:itemType'] as string) ?? undefined;

        await ctx.fastify.db.execute(
          sql`UPDATE plugin_pm_work_items
              SET title = COALESCE(${title ?? null}, title),
                  description = COALESCE(${description ?? null}, description),
                  priority = COALESCE(${priority ?? null}, priority),
                  item_type = COALESCE(${itemType ?? null}, item_type),
                  updated_at = NOW()
              WHERE id = ${item.id}`,
        );

        broadcastToBoard(ctx, item.server_id, item.board_slug, slug);
        ctx.fastify.log.info({ slug }, 'Remote Update(WorkItem) processed');
      },

      handleDelete: async (ctx, objectUri) => {
        // Only handle URIs that look like our work-item URIs.
        const match = objectUri.match(/\/plugins\/project-management\/tasks\/([^/]+)$/);
        if (!match) return;
        const slug = match[1];
        const item = await remoteOwnedItem(ctx, slug);
        if (!item) return;

        await ctx.fastify.db.execute(sql`DELETE FROM plugin_pm_work_items WHERE id = ${item.id}`);
        if (item.chat_id) {
          await ctx.fastify.db.execute(sql`DELETE FROM objects WHERE id = ${item.chat_id}`);
        }

        broadcastToBoard(ctx, item.server_id, item.board_slug, slug);
        ctx.fastify.log.info({ slug }, 'Remote Delete(WorkItem) processed');
      },
    },
  },

  federationHandlers: {
    // [[task:slug]] and [[server@tower:task:slug]] — the plugin loader
    // auto-mounts /plugins/project-management/task/by-slug/:slug which
    // delegates here. Returns the WorkItemView shape the client's
    // TaskPreview renders.
    task: {
      resolveBySlug: async (slug, ctx) => {
        const rows = (await ctx.fastify.db.execute(
          sql`SELECT w.*, b.server_id
                FROM plugin_pm_work_items w
                JOIN plugin_pm_boards b ON b.id = w.board_id
               WHERE w.slug = ${slug}
               LIMIT 1`,
        )) as unknown as (WorkItemRow & { server_id: string })[];
        const item = rows[0];
        if (!item) return null;
        // Locked and missing look the same to the caller.
        if (!(await canAccess(ctx.fastify, ctx.caller, item.server_id))) return null;
        return {
          slug: item.slug,
          title: item.title,
          description: item.description,
          priority: item.priority,
          itemType: item.item_type,
          reporterId: item.reporter_id,
          assigneeId: item.assignee_id,
          storyPoints: item.story_points,
          dueDate: item.due_date,
          position: item.position,
          columnId: item.column_id,
          chatId: item.chat_id,
          createdAt: item.created_at,
          updatedAt: item.updated_at,
        } satisfies WorkItemView;
      },
    },
    // [[board:slug]] — returns the full BoardDetail so the client's
    // BoardPreview can render a mini read-only kanban.
    board: {
      resolveBySlug: async (slug, ctx) => {
        const boards = (await ctx.fastify.db.execute(
          sql`SELECT * FROM plugin_pm_boards WHERE slug = ${slug} LIMIT 1`,
        )) as unknown as BoardRow[];
        const board = boards[0];
        if (!board) return null;
        if (!(await canAccess(ctx.fastify, ctx.caller, board.server_id))) return null;
        const columns = (await ctx.fastify.db.execute(
          sql`SELECT * FROM plugin_pm_columns WHERE board_id = ${board.id} ORDER BY position`,
        )) as unknown as ColumnRow[];
        const items = (await ctx.fastify.db.execute(
          sql`SELECT * FROM plugin_pm_work_items
              WHERE board_id = ${board.id}
              ORDER BY column_id, position`,
        )) as unknown as WorkItemRow[];
        const byColumn = new Map<string, WorkItemView[]>();
        for (const i of items) {
          const view: WorkItemView = {
            slug: i.slug,
            title: i.title,
            description: i.description,
            priority: i.priority,
            itemType: i.item_type,
            reporterId: i.reporter_id,
            assigneeId: i.assignee_id,
            storyPoints: i.story_points,
            dueDate: i.due_date,
            position: i.position,
            columnId: i.column_id,
            chatId: i.chat_id,
            createdAt: i.created_at,
            updatedAt: i.updated_at,
          };
          const bucket = byColumn.get(i.column_id) ?? [];
          bucket.push(view);
          byColumn.set(i.column_id, bucket);
        }
        return {
          slug: board.slug,
          name: board.name,
          description: board.description,
          workItemCount: items.length,
          createdBy: board.created_by,
          createdAt: board.created_at,
          updatedAt: board.updated_at,
          columns: columns.map((c) => ({
            id: c.id,
            name: c.name,
            position: c.position,
            wipLimit: c.wip_limit,
            workItems: byColumn.get(c.id) ?? [],
          })),
        } satisfies BoardDetail;
      },
    },
  },
});

export type { BoardSummary, BoardDetail, ColumnView, WorkItemView };
