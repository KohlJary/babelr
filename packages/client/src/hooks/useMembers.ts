// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect, useCallback } from 'react';
import * as api from '../api';

export function useMembers(serverId: string | null) {
  const [members, setMembers] = useState<api.MemberView[]>([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!serverId) {
      setMembers([]);
      return;
    }
    setLoading(true);
    try {
      const next = await api.getMembers(serverId);
      setMembers(next);
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setRole = useCallback(
    async (userId: string, role: string) => {
      if (!serverId) return;
      await api.setMemberRole(serverId, userId, role);
      setMembers((prev) => prev.map((m) => (m.id === userId ? { ...m, role } : m)));
    },
    [serverId],
  );

  const kick = useCallback(
    async (userId: string) => {
      if (!serverId) return;
      await api.kickMember(serverId, userId);
      setMembers((prev) => prev.filter((m) => m.id !== userId));
    },
    [serverId],
  );

  return { members, loading, reload, setRole, kick };
}
