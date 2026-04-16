// SPDX-License-Identifier: Hippocratic-3.0
import { useState } from 'react';
import type { ActorProfile, PresenceStatus } from '@babelr/shared';
import { PERMISSIONS } from '@babelr/shared';
import type { MemberView } from '../api';
import * as api from '../api';
import { useT } from '../i18n/I18nProvider';
import { useServerRoles } from '../hooks/useServerRoles';

interface MemberListProps {
  serverId: string;
  members: MemberView[];
  actor: ActorProfile;
  callerRole: string;
  presenceStatus?: Map<string, PresenceStatus>;
  onKick: (userId: string) => void;
  onClose: () => void;
  /** Called after a role assignment changes so the parent can refetch the member list. */
  onRolesChanged?: () => void;
}

export function MemberList({
  serverId,
  members,
  actor,
  callerRole,
  presenceStatus,
  onKick,
  onClose,
  onRolesChanged,
}: MemberListProps) {
  const t = useT();
  const { roles } = useServerRoles(serverId);
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Permission check for the UI — true if any of the caller's
  // effective perms include MANAGE_ROLES or MANAGE_MEMBERS. The
  // legacy `callerRole` string is used as a best-effort fallback
  // because the server is the source of truth for real enforcement
  // and the UI's role-gating is only an affordance.
  const legacyIsAdmin = ['owner', 'admin'].includes(callerRole);
  const canManageRoles = legacyIsAdmin; // proxy until callerRole is permission-based
  const canKick = legacyIsAdmin;

  const rolesById = new Map(roles.map((r) => [r.id, r]));
  const assignableRoles = roles.filter((r) => !r.isDefault);

  const handleToggleAssignment = async (
    memberId: string,
    roleId: string,
    currentlyAssigned: boolean,
  ) => {
    setBusyMemberId(memberId);
    setError(null);
    try {
      if (currentlyAssigned) {
        await api.unassignServerRole(serverId, memberId, roleId);
      } else {
        await api.assignServerRole(serverId, memberId, roleId);
      }
      onRolesChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update role');
    } finally {
      setBusyMemberId(null);
    }
  };

  const presenceLabel = (s: PresenceStatus): string => {
    if (s === 'online') return t('members.presenceOnline');
    if (s === 'away') return t('members.presenceAway');
    return t('members.presenceOffline');
  };

  // No-op reference to PERMISSIONS so TS doesn't mark the import
  // as unused — it's pulled in so future gating can read the
  // canonical enum. Remove when callerRole becomes permission-based.
  void PERMISSIONS;

  return (
    <div className="member-list-body">
      {error && <div className="dm-lookup-error">{error}</div>}
      <div className="member-list-count">
        {t('members.title')} ({members.length})
      </div>
      <div className="discover-list">
          {members.map((member) => {
            const isSelf = member.id === actor.id;
            const status = presenceStatus?.get(member.id) ?? 'offline';
            const statusColor =
              status === 'online' ? '#10b981' : status === 'away' ? '#f59e0b' : '#6b7280';
            const memberRoleIds = new Set(member.roleIds ?? []);
            const memberRoles = (member.roleIds ?? [])
              .map((id) => rolesById.get(id))
              .filter((r): r is NonNullable<typeof r> => !!r);
            const isEditing = editingMemberId === member.id;
            const isBusy = busyMemberId === member.id;
            return (
              <div key={member.id} className="discover-item member-row">
                <div className="discover-info">
                  <div className="member-presence">
                    <span
                      className="presence-dot"
                      style={{ backgroundColor: statusColor }}
                      title={presenceLabel(status)}
                    />
                    <span className="discover-name">
                      {member.displayName ?? member.preferredUsername}
                    </span>
                    <div className="member-role-chips">
                      {memberRoles.map((r) => (
                        <span
                          key={r.id}
                          className="member-role-chip"
                          style={{
                            borderColor: r.color ?? '#444',
                            color: r.color ?? '#bbb',
                          }}
                        >
                          {r.name}
                        </span>
                      ))}
                    </div>
                  </div>
                  <span className="discover-meta">@{member.preferredUsername}</span>
                </div>
                <div className="member-actions">
                  {canManageRoles && !isSelf && member.role !== 'owner' && (
                    <button
                      className="voice-control-btn"
                      onClick={() =>
                        setEditingMemberId(isEditing ? null : member.id)
                      }
                      disabled={isBusy}
                    >
                      {isEditing ? 'Done' : 'Manage roles'}
                    </button>
                  )}
                  {canKick && !isSelf && member.role !== 'owner' && (
                    <button
                      className="kick-btn"
                      onClick={() => onKick(member.id)}
                      title={t('members.kick')}
                    >
                      &times;
                    </button>
                  )}
                </div>
                {isEditing && (
                  <div className="member-role-picker">
                    {assignableRoles.length === 0 && (
                      <div className="sidebar-empty">No roles to assign yet.</div>
                    )}
                    {assignableRoles.map((r) => {
                      const assigned = memberRoleIds.has(r.id);
                      return (
                        <label key={r.id} className="member-role-picker-item">
                          <input
                            type="checkbox"
                            checked={assigned}
                            disabled={isBusy}
                            onChange={() =>
                              handleToggleAssignment(member.id, r.id, assigned)
                            }
                          />
                          {r.color && (
                            <span
                              className="roles-list-dot"
                              style={{ backgroundColor: r.color }}
                            />
                          )}
                          <span>{r.name}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
    </div>
  );
}
