// SPDX-License-Identifier: Hippocratic-3.0
import { auditLogs } from './db/schema/audit-logs.ts';

// Loose DB type to avoid circular imports with createDb
type AnyDb = { insert: (table: typeof auditLogs) => { values: (v: typeof auditLogs.$inferInsert) => unknown } };

export interface AuditEntry {
  serverId: string;
  actorId: string;
  category: string;
  action: string;
  summary: string;
  details?: Record<string, unknown>;
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
    });
  } catch (err) {
    console.error('Failed to write audit log:', err);
  }
}
