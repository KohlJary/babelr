// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect, useCallback } from 'react';
import * as api from '../api';

export function useMembers(serverId: string | null) {
  const [members, setMembers] = useState<api.MemberView[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!serverId) {
      setMembers([]);
      return;
    }
    setLoading(true);
    api
      .getMembers(serverId)
      .then(setMembers)
      .finally(() => setLoading(false));
  }, [serverId]);

  const setRole = useCallback(
    async (userId: string, role: string) => {
      if (!serverId) return;
      await api.setMemberRole(serverId, userId, role);
      setMembers((prev) =>
        prev.map((m) => (m.id === userId ? { ...m, role } : m)),
      );
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

  return { members, loading, setRole, kick };
}
