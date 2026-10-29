// SPDX-License-Identifier: MIT

export interface RegisterInput {
  username: string;
  email: string;
  password: string;
  preferredLanguage?: string;
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
  createdAt: Date;
}
