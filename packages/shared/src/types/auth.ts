// SPDX-License-Identifier: MIT

export interface RegisterInput {
  username: string;
  email: string;
  password: string;
  preferredLanguage?: string;
  /** A server invite code. Required when the instance is invite-only;
   *  in any mode it also joins the new account to that server. */
  inviteCode?: string;
}

/** GET /auth/registration: whether this instance takes sign-ups. */
export interface RegistrationInfo {
  mode: 'open' | 'invite' | 'closed';
  /** Sign-up needs an invite link (invite mode, past the first account). */
  inviteRequired: boolean;
  /** Nobody can sign up (closed mode, past the first account). */
  closed: boolean;
}

/** GET /invites/:code: what an invite link leads to, before sign-in. */
export interface InvitePreview {
  valid: boolean;
  error?: string;
  server?: { id: string; name: string };
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface ActorProfile {
  id: string;
  uri: string;
  preferredUsername: string;
  displayName: string | null;
  preferredLanguage: string;
  emailVerified: boolean;
  totpEnabled: boolean;
  avatarUrl?: string | null;
  summary?: string | null;
  /** Other names this account answers to, e.g. in a plan's approvers. */
  aliases?: string[];
  createdAt: Date;
}
