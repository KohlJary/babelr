// SPDX-License-Identifier: MIT
import { auditLogs } from './db/schema/audit-logs.ts';

// Loose DB type to avoid circular imports with createDb
type AnyDb = {
  insert: (table: typeof auditLogs) => { values: (v: typeof auditLogs.$inferInsert) => unknown };
};

export interface AuditEntry {
  /** Null for account-level events (agent management). */
  serverId: string | null;
  actorId: string;
  category: string;
  action: string;
  summary: string;
  details?: Record<string, unknown>;
  sponsorId?: string | null;
  scope?: string | null;
  route?: string | null;
}

/**
 * Write an audit log entry. Fire-and-forget — failures are logged
 * but never block the request that triggered them.
 */
export async function writeAuditLog(db: AnyDb, entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      serverId: entry.serverId,
      actorId: entry.actorId,
      category: entry.category,
      action: entry.action,
      summary: entry.summary,
      details: entry.details,
      sponsorId: entry.sponsorId ?? null,
      scope: entry.scope ?? null,
      route: entry.route ?? null,
    });
  } catch (err) {
    console.error('Failed to write audit log:', err);
  }
}
