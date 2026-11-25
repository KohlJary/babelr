// SPDX-License-Identifier: MIT
import type { AuthorView } from './messages.js';

/**
 * Welcoming newcomers. A member opts itself in, per server; when a
 * person joins that server, each opted-in member gets a DM with them
 * and a welcome to act on. The first message is the welcomer's to
 * write: nothing is sent in their name.
 */

/** One of my servers, and whether I'm welcoming newcomers there. */
export interface WelcomeSetting {
  serverId: string;
  serverName: string;
  welcoming: boolean;
  since: string | null;
}

export type WelcomeState = 'pending' | 'done' | 'skipped';

/** A newcomer for me to say hello to. */
export interface WelcomeView {
  id: string;
  server: { id: string; name: string };
  newcomer: AuthorView;
  /** Who made the invite they came in on, when the server knows. */
  invitedBy: AuthorView | null;
  /** The DM to say hello in (null when skipped). */
  dmId: string | null;
  state: WelcomeState;
  /** Why it was skipped: 'blocked', 'left', 'declined', 'newcomer_policy',
   *  'request' (the newcomer's policy made it a message request), 'no_key'. */
  reason: string | null;
  /** The newcomer has published an E2E key, so a hello can be encrypted
   *  to them now. Until then, wait. */
  newcomerKeyReady: boolean;
  createdAt: string;
  doneAt: string | null;
}

/** A server's welcomers, for its managers. */
export interface WelcomerView {
  actor: AuthorView;
  since: string;
}
