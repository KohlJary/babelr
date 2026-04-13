// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { eq, and, desc, lt } from 'drizzle-orm';
import '../types.ts';
import { auditLogs } from '../db/schema/audit-logs.ts';
import { actors } from '../db/schema/actors.ts';
import { PERMISSIONS } from '@babelr/shared';
import { hasPermission } from '../permissions.ts';
import type { AuditLogEntry, AuditLogResponse } from '@babelr/shared';

const DEFAULT_LIMIT = 50;

export default async function auditRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  fastify.get<{
    Params: { serverId: string };
    Querystring: { category?: string; cursor?: string; limit?: string };
  }>('/servers/:serverId/audit-log', async (request, reply) => {
    if (!request.actor) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    if (
      !(await hasPermission(
        db,
        request.params.serverId,
        request.actor.id,
        PERMISSIONS.VIEW_AUDIT_LOG,
      ))
    ) {
      return reply.status(403).send({ error: 'Insufficient permissions' });
    }

    const limit = Math.min(
      parseInt(request.query.limit ?? String(DEFAULT_LIMIT), 10),
      100,
    );

    const conditions = [eq(auditLogs.serverId, request.params.serverId)];

    if (request.query.category) {
      conditions.push(eq(auditLogs.category, request.query.category));
    }

    if (request.query.cursor) {
      conditions.push(lt(auditLogs.createdAt, new Date(request.query.cursor)));
    }

    const rows = await db
      .select({
        log: auditLogs,
        actor: actors,
      })
      .from(auditLogs)
      .innerJoin(actors, eq(auditLogs.actorId, actors.id))
      .where(and(...conditions))
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit + 1);

    const entries: AuditLogEntry[] = rows.slice(0, limit).map((r) => ({
      id: r.log.id,
      actorId: r.log.actorId,
      actorName: r.actor.displayName ?? r.actor.preferredUsername,
      category: r.log.category,
      action: r.log.action,
      summary: r.log.summary,
      details: r.log.details ?? undefined,
      createdAt: r.log.createdAt.toISOString(),
    }));

    const hasMore = rows.length > limit;
    const response: AuditLogResponse = { entries, hasMore };
    if (hasMore && entries.length > 0) {
      response.cursor = entries[entries.length - 1].createdAt;
    }
    return response;
  });
}
