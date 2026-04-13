// SPDX-License-Identifier: Hippocratic-3.0

export interface AuditLogEntry {
  id: string;
  actorId: string;
  actorName: string;
  category: string;
  action: string;
  summary: string;
  details?: Record<string, unknown>;
  createdAt: string;
}

export interface AuditLogResponse {
  entries: AuditLogEntry[];
  hasMore: boolean;
  cursor?: string;
}
