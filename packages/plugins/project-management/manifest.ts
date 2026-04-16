// SPDX-License-Identifier: Hippocratic-3.0
import { definePlugin } from '@babelr/plugin-sdk';
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
    function buildWorkItemObject(
      item: WorkItemRow,
      origin: string,
    ): Record<string, unknown> {
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
      boardSlug: string,
      kind: 'work-item' | 'reorder' | 'board',
      slug?: string,
    ) {
      fastify.broadcastToAllSubscribers({
        type: 'plugin:pm:updated' as never,
        payload: { boardSlug, kind, slug } as never,
      });
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
      broadcastPm(boardSlug, 'board');
      return detail;
    });

    fastify.get<{ Querystring: { serverId?: string } }>(
      '/boards',
      async (request, reply) => {
        if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
        const { serverId } = request.query;
        if (!serverId) {
          return reply.status(400).send({ error: 'serverId query param is required' });
        }
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
      },
    );

    fastify.get<{ Params: { slug: string } }>('/boards/:slug', async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
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
      const boards = (await fastify.db.execute(
        sql`SELECT id FROM plugin_pm_boards WHERE slug = ${request.params.slug} LIMIT 1`,
      )) as unknown as { id: string }[];
      const board = boards[0];
      if (!board) return reply.status(404).send({ error: 'Board not found' });

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
      broadcastPm(request.params.slug, 'work-item', item.slug);
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

    fastify.get<{ Params: { slug: string } }>(
      '/work-items/:slug',
      async (request, reply) => {
        if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
        const items = (await fastify.db.execute(
          sql`SELECT * FROM plugin_pm_work_items WHERE slug = ${request.params.slug} LIMIT 1`,
        )) as unknown as WorkItemRow[];
        const i = items[0];
        if (!i) return reply.status(404).send({ error: 'Work item not found' });
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
      },
    );

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
      const boards = (await fastify.db.execute(
        sql`SELECT * FROM plugin_pm_boards WHERE slug = ${request.params.slug} LIMIT 1`,
      )) as unknown as BoardRow[];
      const board = boards[0];
      if (!board) return reply.status(404).send({ error: 'Board not found' });

      // itemIds are work-item slugs (what the client holds). Server
      // resolves slug → row id below; a single SELECT ANY() makes the
      // validation one round-trip instead of per-item.
      const columnIds = assignments.map((a) => a.columnId);
      const itemSlugs = assignments.flatMap((a) => a.itemIds);

      const cols = (await fastify.db.execute(
        sql`SELECT id FROM plugin_pm_columns
            WHERE board_id = ${board.id} AND id = ANY(${columnIds})`,
      )) as unknown as { id: string }[];
      if (cols.length !== columnIds.length) {
        return reply.status(400).send({ error: 'columnId not on this board' });
      }
      if (itemSlugs.length > 0) {
        const items = (await fastify.db.execute(
          sql`SELECT slug FROM plugin_pm_work_items
              WHERE board_id = ${board.id} AND slug = ANY(${itemSlugs})`,
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
      broadcastPm(request.params.slug, 'reorder');
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
      const existing = (await fastify.db.execute(
        sql`SELECT * FROM plugin_pm_work_items WHERE slug = ${request.params.slug} LIMIT 1`,
      )) as unknown as WorkItemRow[];
      const current = existing[0];
      if (!current) return reply.status(404).send({ error: 'Work item not found' });

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
      const nextAssignee =
        body.assigneeId !== undefined ? body.assigneeId : current.assignee_id;
      const nextStoryPoints =
        body.storyPoints !== undefined ? body.storyPoints : current.story_points;
      const nextDueDate = body.dueDate !== undefined ? body.dueDate : current.due_date;

      if (body.columnId && body.columnId !== current.column_id) {
        // Cross-column move — verify destination belongs to the same board.
        const check = (await fastify.db.execute(
          sql`SELECT id FROM plugin_pm_columns WHERE id = ${body.columnId} AND board_id = ${current.board_id}`,
        )) as unknown as { id: string }[];
        if (check.length === 0) {
          return reply
            .status(400)
            .send({ error: 'columnId does not belong to this board' });
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
      const parentBoard = (await fastify.db.execute(
        sql`SELECT slug FROM plugin_pm_boards WHERE id = ${item.board_id} LIMIT 1`,
      )) as unknown as { slug: string }[];
      if (parentBoard[0]) {
        broadcastPm(parentBoard[0].slug, 'work-item', item.slug);
      }
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

    fastify.delete<{ Params: { slug: string } }>(
      '/work-items/:slug',
      async (request, reply) => {
        if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
        // Fetch full row before deleting so we can construct the AS2
        // Delete activity with proper context.
        const existing = (await fastify.db.execute(
          sql`SELECT * FROM plugin_pm_work_items WHERE slug = ${request.params.slug} LIMIT 1`,
        )) as unknown as WorkItemRow[];
        const toDelete = existing[0];
        if (!toDelete) return reply.status(404).send({ error: 'Work item not found' });
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
          await fastify.db.execute(
            sql`DELETE FROM objects WHERE id = ${chatId}`,
          );
        }
        const parentBoard = (await fastify.db.execute(
          sql`SELECT slug FROM plugin_pm_boards WHERE id = ${res[0].board_id} LIMIT 1`,
        )) as unknown as { slug: string }[];
        if (parentBoard[0]) {
          broadcastPm(parentBoard[0].slug, 'work-item', request.params.slug);
        }
        void deliverWorkItem('Delete', toDelete);
        return reply.status(204).send();
      },
    );
  },

  inboxHandlers: {
    WorkItem: {
      handleCreate: async (ctx, objData) => {
        const boardId = objData['babelr:boardId'] as string | undefined;
        const slug = objData['babelr:slug'] as string | undefined;
        if (!boardId || !slug) return;

        // Verify the board exists on this tower.
        const boards = (await ctx.fastify.db.execute(
          sql`SELECT id FROM plugin_pm_boards WHERE id = ${boardId} LIMIT 1`,
        )) as unknown as { id: string }[];
        if (!boards[0]) return;

        const columnId = objData['babelr:columnId'] as string | undefined;
        const title = (objData.content as string) ?? '';
        const source = objData.source as { content?: string } | undefined;
        const description = source?.content || null;
        const priority = (objData['babelr:priority'] as string) ?? 'medium';
        const itemType = (objData['babelr:itemType'] as string) ?? 'task';

        // Upsert — the same work item may arrive more than once via
        // Group-relay redelivery.
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
                    updated_at = NOW()`,
        );

        // Look up board slug for WS broadcast.
        const bs = (await ctx.fastify.db.execute(
          sql`SELECT slug FROM plugin_pm_boards WHERE id = ${boardId} LIMIT 1`,
        )) as unknown as { slug: string }[];
        if (bs[0]) {
          ctx.fastify.broadcastToAllSubscribers({
            type: 'plugin:pm:updated' as never,
            payload: { boardSlug: bs[0].slug, kind: 'work-item', slug } as never,
          });
        }
        ctx.fastify.log.info({ slug }, 'Remote Create(WorkItem) processed');
      },

      handleUpdate: async (ctx, objData) => {
        const slug = objData['babelr:slug'] as string | undefined;
        if (!slug) return;

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
              WHERE slug = ${slug}`,
        );

        const items = (await ctx.fastify.db.execute(
          sql`SELECT board_id FROM plugin_pm_work_items WHERE slug = ${slug} LIMIT 1`,
        )) as unknown as { board_id: string }[];
        if (items[0]) {
          const bs = (await ctx.fastify.db.execute(
            sql`SELECT slug FROM plugin_pm_boards WHERE id = ${items[0].board_id} LIMIT 1`,
          )) as unknown as { slug: string }[];
          if (bs[0]) {
            ctx.fastify.broadcastToAllSubscribers({
              type: 'plugin:pm:updated' as never,
              payload: { boardSlug: bs[0].slug, kind: 'work-item', slug } as never,
            });
          }
        }
        ctx.fastify.log.info({ slug }, 'Remote Update(WorkItem) processed');
      },

      handleDelete: async (ctx, objectUri) => {
        // Only handle URIs that look like our work-item URIs.
        const match = objectUri.match(/\/plugins\/project-management\/tasks\/([^/]+)$/);
        if (!match) return;
        const slug = match[1];

        const items = (await ctx.fastify.db.execute(
          sql`SELECT board_id, chat_id FROM plugin_pm_work_items WHERE slug = ${slug} LIMIT 1`,
        )) as unknown as { board_id: string; chat_id: string | null }[];
        const item = items[0];
        if (!item) return;

        await ctx.fastify.db.execute(
          sql`DELETE FROM plugin_pm_work_items WHERE slug = ${slug}`,
        );
        if (item.chat_id) {
          await ctx.fastify.db.execute(
            sql`DELETE FROM objects WHERE id = ${item.chat_id}`,
          );
        }

        const bs = (await ctx.fastify.db.execute(
          sql`SELECT slug FROM plugin_pm_boards WHERE id = ${item.board_id} LIMIT 1`,
        )) as unknown as { slug: string }[];
        if (bs[0]) {
          ctx.fastify.broadcastToAllSubscribers({
            type: 'plugin:pm:updated' as never,
            payload: { boardSlug: bs[0].slug, kind: 'work-item', slug } as never,
          });
        }
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
          sql`SELECT * FROM plugin_pm_work_items WHERE slug = ${slug} LIMIT 1`,
        )) as unknown as WorkItemRow[];
        const item = rows[0];
        if (!item) return null;
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
