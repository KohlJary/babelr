// SPDX-License-Identifier: Hippocratic-3.0
import { useCallback, useEffect, useState } from 'react';
import type {
  ServerRoleView,
  CreateServerRoleInput,
  UpdateServerRoleInput,
} from '@babelr/shared';
import * as api from '../api';

/**
 * Loads and mutates the role list for a server. Mirrors the shape
 * of `useWikiPages`: fetch on mount, expose CRUD actions that call
 * the API and re-fetch. Role management is infrequent enough that
 * the extra round-trip on each mutation is fine — a stale-then-
 * revalidate cache would be premature optimization.
 */
export function useServerRoles(serverId: string | null) {
  const [roles, setRoles] = useState<ServerRoleView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!serverId) {
      setRoles([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api.listServerRoles(serverId);
      setRoles(res.roles);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load roles');
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const createRole = useCallback(
    async (input: CreateServerRoleInput): Promise<ServerRoleView | null> => {
      if (!serverId) return null;
      const res = await api.createServerRole(serverId, input);
      await reload();
      return res.role;
    },
    [serverId, reload],
  );

  const updateRole = useCallback(
    async (roleId: string, input: UpdateServerRoleInput): Promise<ServerRoleView | null> => {
      if (!serverId) return null;
      const res = await api.updateServerRole(serverId, roleId, input);
      await reload();
      return res.role;
    },
    [serverId, reload],
  );

  const deleteRole = useCallback(
    async (roleId: string): Promise<boolean> => {
      if (!serverId) return false;
      await api.deleteServerRole(serverId, roleId);
      await reload();
      return true;
    },
    [serverId, reload],
  );

  return { roles, loading, error, reload, createRole, updateRole, deleteRole };
}
