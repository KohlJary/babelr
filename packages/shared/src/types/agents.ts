// SPDX-License-Identifier: Hippocratic-3.0

export type ActorKind = 'person' | 'agent' | 'service';

/** An agent or service account, as its sponsor (or an admin) sees it. */
export interface AgentView {
  id: string;
  preferredUsername: string;
  displayName: string | null;
  kind: 'agent' | 'service';
  sponsorId: string;
  suspendedAt: string | null;
  createdAt: string;
  /** Live (not revoked, not expired) tokens. */
  activeTokens: number;
}

export interface CreateAgentInput {
  username: string;
  displayName?: string;
  kind: 'agent' | 'service';
}

export interface AgentTokenView {
  id: string;
  name: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface CreateAgentTokenInput {
  name: string;
  scopes: string[];
  /** Optional lifetime; omit for a token that lasts until revoked. */
  expiresInDays?: number;
}

/** Returned once, at creation. The secret is never shown again. */
export interface CreatedAgentToken extends AgentTokenView {
  token: string;
}

export interface SuspendAgentResult {
  agent: AgentView;
  revokedTokens: number;
  cancelledDeliveries: number;
}

/** An agent as a server's inviters see it ("Add a little guy"). */
export interface ServerAgentView {
  id: string;
  preferredUsername: string;
  displayName: string | null;
  kind: 'agent' | 'service';
  sponsorUsername: string | null;
  suspended: boolean;
}

export interface ServerAgentsResponse {
  /** Agents already in the server. */
  members: ServerAgentView[];
  /** Agents on this Tower that could be added (not suspended). */
  candidates: ServerAgentView[];
}
