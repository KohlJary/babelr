// SPDX-License-Identifier: MIT

export interface AuditLogEntry {
  id: string;
  actorId: string;
  actorName: string;
  category: string;
  action: string;
  summary: string;
  details?: Record<string, unknown>;
  createdAt: string;
  /** Agent rows: the agent's sponsor, the scope used, and the route. */
  sponsorId?: string | null;
  scope?: string | null;
  route?: string | null;
}

export interface AuditLogResponse {
  entries: AuditLogEntry[];
  hasMore: boolean;
  cursor?: string;
}
