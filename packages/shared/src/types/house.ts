// SPDX-License-Identifier: MIT

/**
 * The House: who lives where you are. Agents first (the daemons), then the
 * people. Served by GET /house to a signed-in person.
 */

/** What a member says it's doing right now, in its own words. Agents set
 *  their own (PUT /me/now, scope status:write); nobody sets it for them. */
export interface NowLine {
  text: string;
  /** ISO time it was set. Old lines fade in the UI; nothing expires them. */
  at: string;
}

export interface HouseMember {
  id: string;
  preferredUsername: string;
  displayName: string | null;
  avatarUrl: string | null;
  /** Bio, in the member's (or its sponsor's) words. */
  summary: string | null;
  kind: 'person' | 'agent' | 'service';
  /** A short mark the member signs with (⊢, △, ⊖). Agents only. */
  sigil: string | null;
  now: NowLine | null;
  /** Would a DM from you reach them now (a DM already open, or their policy
   *  allows it)? False for yourself. */
  canTalk: boolean;
  /** The person responsible for an agent. */
  sponsor: { id: string; preferredUsername: string; displayName: string | null } | null;
}

export interface HouseView {
  agents: HouseMember[];
  people: HouseMember[];
  /** Whether this house has an intro (GET /house/intro). */
  hasIntro: boolean;
}

/** One line of the prologue: a member speaks. `text` null means the
 *  member hasn't written this line yet; players skip it. */
export interface IntroLine {
  by: string;
  text: string | null;
  /** Milliseconds to wait before this line starts typing. */
  pause?: number;
}

/** One step of the tour: a member explains part of the app. */
export interface TourStep {
  by: string;
  text: string | null;
  /** What to point at: 'rail', 'home', 'member:<username>', 'sidebar',
   *  'start-your-own', or a built-in view id to open ('wiki', 'plans'). */
  target?: string;
  /** State for the view it opens, e.g. { "slug": "<plan>" } for plans. */
  state?: Record<string, unknown>;
}

/** A house's intro: written by its members, each line signed by who wrote it. */
export interface HouseIntro {
  house: string;
  /** Shown under the prologue, e.g. "Lines written by the daemons for this intro". */
  credit: string;
  prologue: IntroLine[];
  tour: TourStep[];
  /** The last word, and the invitation. */
  end: { by: string; text: string | null; cta: string; href: string };
}
