// SPDX-License-Identifier: Hippocratic-3.0
import type { ActorProfile } from '@babelr/shared';
import type { MemberView } from '../api';

interface MemberListProps {
  members: MemberView[];
  actor: ActorProfile;
  callerRole: string;
  onSetRole: (userId: string, role: string) => void;
  onKick: (userId: string) => void;
  onClose: () => void;
}

const ROLES = ['member', 'moderator', 'admin'];

export function MemberList({
  members,
  actor,
  callerRole,
  onSetRole,
  onKick,
  onClose,
}: MemberListProps) {
  const canManageRoles = callerRole === 'owner';
  const canKick = callerRole === 'owner' || callerRole === 'admin';

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Members ({members.length})</h2>
          <button className="settings-close" onClick={onClose}>
            &times;
          </button>
        </div>
        <div className="discover-list">
          {members.map((member) => {
            const isSelf = member.id === actor.id;
            return (
              <div key={member.id} className="discover-item">
                <div className="discover-info">
                  <span className="discover-name">
                    {member.displayName ?? member.preferredUsername}
                  </span>
                  <span className="discover-meta">
                    @{member.preferredUsername} &middot; {member.role}
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
                          {r}
                        </option>
                      ))}
                    </select>
                  )}
                  {canKick && !isSelf && member.role !== 'owner' && (
                    <button className="kick-btn" onClick={() => onKick(member.id)} title="Kick">
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
