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
  /** The inviter's label for them ("Mom"), from the guest card. */
  invitedAs: string | null;
  /** The guest card the invite was made from. `seeds` is null unless the
   *  newcomer said yes to the house looking them up. */
  card: GuestCardBrief | null;
  /** The newcomer's answer about the card's seeds: true, false, or null
   *  (not answered yet, or there were no seeds to ask about). */
  consented: boolean | null;
  /** The card has seeds and the newcomer hasn't answered yet. */
  seedsPending: boolean;
  createdAt: string;
  doneAt: string | null;
}

/** A server's welcomers, for its managers. */
export interface WelcomerView {
  actor: AuthorView;
  since: string;
}

/** One fact about the person on a card, with who added it and from where
 *  ('inviter' today; later 'self', 'lookup:<url>', 'promoted:<daemon>'). */
export interface GuestCardFact {
  id: string;
  key: string;
  value: string;
  source: string;
  addedBy: string | null;
  createdAt: string;
}

export interface GuestCardBrief {
  id: string;
  name: string;
  label: string | null;
  note: string | null;
  seeds: string | null;
  /** Like seeds: only with the person's yes. */
  facts: GuestCardFact[];
}

export type GuestCardStatus = 'not_sent' | 'link_made' | 'joined' | 'declined_lookup';

/**
 * An inviter's record of someone they're bringing in. Seen by the
 * inviter, the server's managers and its opted-in welcomers.
 */
export interface GuestCardView {
  id: string;
  serverId: string;
  name: string;
  label: string | null;
  /** Null for a welcomer when the person said no to being looked up. */
  seeds: string | null;
  note: string | null;
  /** Null-equivalent (empty) for a welcomer when the person said no. */
  facts: GuestCardFact[];
  createdBy: AuthorView;
  /** The viewer made this card (and so can edit it and make its invite). */
  mine: boolean;
  status: GuestCardStatus;
  /** The live invite link (inviter and managers only). */
  invite: { code: string; url: string } | null;
  joined: AuthorView | null;
  lookupConsent: boolean | null;
  createdAt: string;
  updatedAt: string;
}

export interface GuestCardInput {
  name: string;
  label?: string | null;
  seeds?: string | null;
  note?: string | null;
  /** The inviter's facts; on update, replaces the inviter's own. */
  facts?: Array<{ key: string; value: string }>;
}

/** What the person themselves sees: who invited them and what they said. */
export interface ArrivalConsentView {
  id: string;
  server: { id: string; name: string };
  invitedBy: { name: string } | null;
  seeds: string;
  /** The inviter's facts, shown with the seeds. */
  facts: Array<{ key: string; value: string }>;
  addedLink: string | null;
  lookupConsent: boolean | null;
}
