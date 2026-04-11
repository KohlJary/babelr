// SPDX-License-Identifier: Hippocratic-3.0

/**
 * Server role as returned by the role management endpoints. Mirrors
 * the `server_roles` table on the server. Permissions are the raw
 * string array from the DB — the UI uses PERMISSION_LABELS and
 * PERMISSION_CATEGORIES to group and display them.
 */
export interface ServerRoleView {
  id: string;
  serverId: string;
  name: string;
  /** Hex color string like "#4b6cb7", or null if no color */
  color: string | null;
  /** Higher position = more privileged. Reserved for the hierarchy follow-up. */
  position: number;
  permissions: string[];
  /** True for the implicit @everyone role. Exactly one per server. */
  isDefault: boolean;
  /** True for roles protected from rename/delete. Currently @everyone only. */
  isSystem: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateServerRoleInput {
  name: string;
  color?: string | null;
  permissions?: string[];
}

export interface UpdateServerRoleInput {
  name?: string;
  color?: string | null;
  permissions?: string[];
}

export interface ServerRoleListResponse {
  roles: ServerRoleView[];
}

export interface ServerRoleResponse {
  role: ServerRoleView;
}
