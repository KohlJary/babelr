// SPDX-License-Identifier: Hippocratic-3.0
import type { AuthorView } from './messages.js';

export type FriendshipState = 'pending_out' | 'pending_in' | 'accepted';

export interface FriendshipView {
  id: string;
  state: FriendshipState;
  other: AuthorView;
  createdAt: string;
  updatedAt: string;
}
