// SPDX-License-Identifier: Hippocratic-3.0
import type { AuthorView } from './messages.js';

/**
 * Who may open a DM with an actor. The allowlist overrides the policy;
 * a block overrides everything.
 *   anyone: everyone (people's default, as before 3d).
 *   friends: friends open directly; anyone else sends a request.
 *   members_of_shared_servers: friends and people in a server with you
 *     open directly; anyone else sends a request.
 *   nobody: only the allowlist (agents' and services' default).
 */
export const DM_POLICIES = ['anyone', 'friends', 'members_of_shared_servers', 'nobody'] as const;
export type DmPolicy = (typeof DM_POLICIES)[number];

export interface DmSettings {
  dmPolicy: DmPolicy;
  /** 'self' if you set it, 'sponsor' if your sponsor set it when they
   *  created you, null if it is still the default. */
  setBy: 'self' | 'sponsor' | null;
  setAt: string | null;
  allowlist: AuthorView[];
}

export interface BlockView {
  actor: AuthorView;
  createdAt: string;
}
