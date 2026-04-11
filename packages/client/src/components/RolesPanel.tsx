// SPDX-License-Identifier: Hippocratic-3.0
import { useEffect, useMemo, useState } from 'react';
import type { ServerRoleView } from '@babelr/shared';
import {
  PERMISSION_CATEGORIES,
  PERMISSION_LABELS,
  type Permission,
} from '@babelr/shared';
import { useServerRoles } from '../hooks/useServerRoles';

interface RolesPanelProps {
  serverId: string;
}

/**
 * Role management surface. Left column lists all roles; right column
 * edits the currently selected one. Create/delete buttons at the top.
 *
 * System roles (currently just @everyone) render in the list with a
 * 🔒 marker and have their name/color/delete controls disabled —
 * permissions can still be edited.
 *
 * The component accumulates pending changes in local state and
 * commits them on a Save click. That way the user can check/uncheck
 * a dozen permission boxes without firing a write on every click.
 * Permissions that don't exist yet in the DEFAULT_ROLE_DEFINITIONS
 * table (e.g. VIEW_AUDIT_LOG) are still selectable — they're
 * reserved-for-future and will work once the corresponding feature
 * ships.
 */
export function RolesPanel({ serverId }: RolesPanelProps) {
  const { roles, loading, error, createRole, updateRole, deleteRole } =
    useServerRoles(serverId);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftColor, setDraftColor] = useState<string>('');
  const [draftPerms, setDraftPerms] = useState<Set<string>>(new Set());
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Auto-select the first non-default role when the list loads.
  useEffect(() => {
    if (selectedRoleId || roles.length === 0) return;
    // Prefer the first non-@everyone role for initial selection; if
    // only @everyone exists, select that.
    const firstNonDefault = roles.find((r) => !r.isDefault) ?? roles[0];
    setSelectedRoleId(firstNonDefault.id);
  }, [roles, selectedRoleId]);

  const selectedRole: ServerRoleView | null = useMemo(
    () => roles.find((r) => r.id === selectedRoleId) ?? null,
    [roles, selectedRoleId],
  );

  // Hydrate the draft state whenever the selected role changes.
  useEffect(() => {
    if (!selectedRole) {
      setDraftName('');
      setDraftColor('');
      setDraftPerms(new Set());
      setDirty(false);
      return;
    }
    setDraftName(selectedRole.name);
    setDraftColor(selectedRole.color ?? '');
    setDraftPerms(new Set(selectedRole.permissions));
    setDirty(false);
    setActionError(null);
  }, [selectedRole]);

  const togglePermission = (perm: Permission) => {
    setDraftPerms((prev) => {
      const next = new Set(prev);
      if (next.has(perm)) next.delete(perm);
      else next.add(perm);
      return next;
    });
    setDirty(true);
  };

  const handleNameChange = (value: string) => {
    setDraftName(value);
    setDirty(true);
  };

  const handleColorChange = (value: string) => {
    setDraftColor(value);
    setDirty(true);
  };

  const handleCreate = async () => {
    setActionError(null);
    try {
      const created = await createRole({
        name: 'New role',
        permissions: [],
      });
      if (created) {
        setSelectedRoleId(created.id);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to create role');
    }
  };

  const handleDelete = async () => {
    if (!selectedRole) return;
    if (selectedRole.isSystem) return;
    if (!confirm(`Delete the role "${selectedRole.name}"? This cannot be undone.`)) return;
    setActionError(null);
    try {
      await deleteRole(selectedRole.id);
      setSelectedRoleId(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete role');
    }
  };

  const handleSave = async () => {
    if (!selectedRole) return;
    setSaving(true);
    setActionError(null);
    try {
      const updates: Parameters<typeof updateRole>[1] = {
        permissions: Array.from(draftPerms),
      };
      if (!selectedRole.isSystem) {
        if (draftName.trim() !== selectedRole.name) updates.name = draftName.trim();
        const currentColor = selectedRole.color ?? '';
        if (draftColor !== currentColor) {
          updates.color = draftColor.trim() || null;
        }
      }
      await updateRole(selectedRole.id, updates);
      setDirty(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to save role');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (!selectedRole) return;
    setDraftName(selectedRole.name);
    setDraftColor(selectedRole.color ?? '');
    setDraftPerms(new Set(selectedRole.permissions));
    setDirty(false);
    setActionError(null);
  };

  return (
    <div className="roles-panel">
      <aside className="roles-sidebar">
        <button className="auth-submit roles-new-btn" onClick={handleCreate}>
          + New role
        </button>
        {loading && <div className="sidebar-empty">Loading roles…</div>}
        {error && <div className="dm-lookup-error">{error}</div>}
        <ul className="roles-list">
          {roles.map((role) => (
            <li key={role.id}>
              <button
                type="button"
                className={`roles-list-item ${
                  selectedRoleId === role.id ? 'selected' : ''
                }`}
                onClick={() => setSelectedRoleId(role.id)}
              >
                {role.color && (
                  <span
                    className="roles-list-dot"
                    style={{ backgroundColor: role.color }}
                  />
                )}
                <span className="roles-list-name">
                  {role.isSystem && <span className="roles-system-marker" title="System role">🔒 </span>}
                  {role.name}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className="roles-editor">
        {!selectedRole && (
          <div className="sidebar-empty">Select or create a role to edit.</div>
        )}
        {selectedRole && (
          <>
            <div className="roles-editor-header">
              <label className="auth-label">
                Name
                <input
                  className="auth-input"
                  type="text"
                  value={draftName}
                  onChange={(e) => handleNameChange(e.target.value)}
                  disabled={selectedRole.isSystem}
                />
              </label>
              <label className="auth-label">
                Color
                <input
                  className="auth-input roles-color-input"
                  type="color"
                  value={draftColor || '#4b6cb7'}
                  onChange={(e) => handleColorChange(e.target.value)}
                  disabled={selectedRole.isSystem}
                />
              </label>
            </div>

            <div className="roles-perm-grid">
              {PERMISSION_CATEGORIES.map((cat) => (
                <section key={cat.id} className="roles-perm-category">
                  <h4 className="roles-perm-category-header">{cat.label}</h4>
                  <ul className="roles-perm-list">
                    {cat.permissions.map((perm) => (
                      <li key={perm}>
                        <label className="roles-perm-item">
                          <input
                            type="checkbox"
                            checked={draftPerms.has(perm)}
                            onChange={() => togglePermission(perm)}
                          />
                          <span>{PERMISSION_LABELS[perm] ?? perm}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>

            {actionError && <div className="dm-lookup-error">{actionError}</div>}

            <div className="roles-editor-actions">
              <button
                type="button"
                className="voice-control-btn"
                onClick={handleReset}
                disabled={!dirty || saving}
              >
                Reset
              </button>
              <button
                type="button"
                className="voice-control-btn leave"
                onClick={handleDelete}
                disabled={selectedRole.isSystem || saving}
              >
                Delete role
              </button>
              <button
                type="button"
                className="auth-submit"
                onClick={handleSave}
                disabled={!dirty || saving}
              >
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
