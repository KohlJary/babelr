// SPDX-License-Identifier: Hippocratic-3.0
import type { ActorProfile, PresenceStatus } from '@babelr/shared';
import type { MemberView } from '../api';
import { useT } from '../i18n/I18nProvider';

interface MemberListProps {
  members: MemberView[];
  actor: ActorProfile;
  callerRole: string;
  presenceStatus?: Map<string, PresenceStatus>;
  onSetRole: (userId: string, role: string) => void;
  onKick: (userId: string) => void;
  onClose: () => void;
}

const ROLES = ['member', 'moderator', 'admin'];

export function MemberList({
  members,
  actor,
  callerRole,
  presenceStatus,
  onSetRole,
  onKick,
  onClose,
}: MemberListProps) {
  const t = useT();
  const canManageRoles = callerRole === 'owner';
  const canKick = callerRole === 'owner' || callerRole === 'admin';

  const roleLabel = (r: string): string => {
    switch (r) {
      case 'owner':
        return t('members.role.owner');
      case 'admin':
        return t('members.role.admin');
      case 'moderator':
        return t('members.role.moderator');
      default:
        return t('members.role.member');
    }
  };

  const presenceLabel = (s: PresenceStatus): string => {
    if (s === 'online') return t('members.presenceOnline');
    if (s === 'away') return t('members.presenceAway');
    return t('members.presenceOffline');
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>{t('members.title')} ({members.length})</h2>
          <button className="settings-close" onClick={onClose}>
            &times;
          </button>
        </div>
        <div className="discover-list">
          {members.map((member) => {
            const isSelf = member.id === actor.id;
            const status = presenceStatus?.get(member.id) ?? 'offline';
            const statusColor = status === 'online' ? '#10b981' : status === 'away' ? '#f59e0b' : '#6b7280';
            return (
              <div key={member.id} className="discover-item">
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
                  </div>
                  <span className="discover-meta">
                    @{member.preferredUsername} &middot; {roleLabel(member.role)}
                  </span>
                </div>
                <div className="member-actions">
                  {canManageRoles && !isSelf && member.role !== 'owner' && (
                    <select
                      value={member.role}
                      onChange={(e) => onSetRole(member.id, e.target.value)}
                      className="role-select"
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {roleLabel(r)}
                        </option>
                      ))}
                    </select>
                  )}
                  {canKick && !isSelf && member.role !== 'owner' && (
                    <button className="kick-btn" onClick={() => onKick(member.id)} title={t('members.kick')}>
                      &times;
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
