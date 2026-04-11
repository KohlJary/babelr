// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect, useCallback } from 'react';
import type { FriendshipView, WsServerMessage } from '@babelr/shared';
import * as api from '../api';
import { useWebSocket } from './useWebSocket';

export function useFriends() {
  const [friendships, setFriendships] = useState<FriendshipView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getFriends()
      .then(setFriendships)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load friends'))
      .finally(() => setLoading(false));
  }, []);

  const handleWsMessage = useCallback((msg: WsServerMessage) => {
    if (msg.type === 'friend:request') {
      setFriendships((prev) => {
        if (prev.find((f) => f.id === msg.payload.friendship.id)) return prev;
        return [msg.payload.friendship, ...prev];
      });
    } else if (msg.type === 'friend:accepted') {
      setFriendships((prev) =>
        prev.map((f) => (f.id === msg.payload.friendship.id ? msg.payload.friendship : f)),
      );
    } else if (msg.type === 'friend:removed') {
      setFriendships((prev) => prev.filter((f) => f.id !== msg.payload.friendshipId));
    } else if (msg.type === 'friend:updated') {
      // Remote friend changed their profile (display name, avatar,
      // bio) — the server has already refreshed the cached actor row
      // and is pushing us the updated FriendshipView. Replace in place.
      setFriendships((prev) =>
        prev.map((f) => (f.id === msg.payload.friendship.id ? msg.payload.friendship : f)),
      );
    }
  }, []);

  useWebSocket(true, handleWsMessage);

  const addFriend = useCallback(async (handle: string) => {
    const row = await api.addFriend(handle);
    setFriendships((prev) => {
      if (prev.find((f) => f.id === row.id)) return prev;
      return [row, ...prev];
    });
    return row;
  }, []);

  const acceptFriend = useCallback(async (friendshipId: string) => {
    const row = await api.acceptFriend(friendshipId);
    setFriendships((prev) => prev.map((f) => (f.id === row.id ? row : f)));
    return row;
  }, []);

  const removeFriend = useCallback(async (friendshipId: string) => {
    await api.removeFriend(friendshipId);
    setFriendships((prev) => prev.filter((f) => f.id !== friendshipId));
  }, []);

  return { friendships, loading, error, addFriend, acceptFriend, removeFriend };
}
