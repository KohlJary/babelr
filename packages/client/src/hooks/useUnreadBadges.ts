// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useCallback } from 'react';
import * as api from '../api';

export function useUnreadBadges() {
  const [unreadCounts, setUnreadCounts] = useState<Map<string, number>>(new Map());

  const getUnread = useCallback(async (channelId: string) => {
    try {
      const { count } = await api.getUnreadCount(channelId);
      setUnreadCounts((prev) => new Map(prev).set(channelId, count));
      return count;
    } catch (error) {
      console.error('Failed to fetch unread count:', error);
      return 0;
    }
  }, []);

  const markAsRead = useCallback(async (channelId: string) => {
    try {
      await api.markChannelAsRead(channelId);
      setUnreadCounts((prev) => new Map(prev).set(channelId, 0));
    } catch (error) {
      console.error('Failed to mark channel as read:', error);
    }
  }, []);

  const incrementUnread = useCallback((channelId: string) => {
    setUnreadCounts((prev) => {
      const next = new Map(prev);
      next.set(channelId, (next.get(channelId) ?? 0) + 1);
      return next;
    });
  }, []);

  return {
    unreadCounts,
    getUnread,
    markAsRead,
    incrementUnread,
  };
}
