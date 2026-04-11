// SPDX-License-Identifier: Hippocratic-3.0

/**
 * Server-scoped permission flags. Shared between client and server so
 * the UI can render role editors and the server can enforce checks
 * with the exact same vocabulary.
 *
 * Each permission is a plain string constant. Roles store their
 * granted permissions as `string[]` in JSONB. Readable in the DB,
 * trivially extensible when we add new flags, no renumbering cost.
 *
 * Grouping is convention-only — it shows up in the settings UI as
 * section headers. The actual evaluation is a flat set-membership
 * check against a role's permissions array.
 *
 * See `docs/permissions-audit.md` for the catalogue of every gated
 * action and which permission gates it.
 */

export const PERMISSIONS = {
  // ---- Server admin ----
  MANAGE_SERVER: 'MANAGE_SERVER',
  MANAGE_ROLES: 'MANAGE_ROLES',
  MANAGE_INVITES: 'MANAGE_INVITES',
  KICK_MEMBERS: 'KICK_MEMBERS',
  /** Reserved for the audit-log follow-up item. Not yet gated on anything. */
  VIEW_AUDIT_LOG: 'VIEW_AUDIT_LOG',

  // ---- Channels ----
  VIEW_CHANNELS: 'VIEW_CHANNELS',
  MANAGE_CHANNELS: 'MANAGE_CHANNELS',

  // ---- Messages ----
  SEND_MESSAGES: 'SEND_MESSAGES',
  /** Delete/edit OTHERS' messages. Creator-override for own messages is
   *  a separate pattern and does not need this flag. */
  MANAGE_MESSAGES: 'MANAGE_MESSAGES',
  ADD_REACTIONS: 'ADD_REACTIONS',
  ATTACH_FILES: 'ATTACH_FILES',
  /** Reserved for @everyone/@here rate limiting. Not yet gated. */
  MENTION_EVERYONE: 'MENTION_EVERYONE',
  /** Any server member can create invites by default. Separate from MANAGE_INVITES
   *  (which is the admin-tier ability to see and revoke the full invite list). */
  CREATE_INVITES: 'CREATE_INVITES',

  // ---- Voice ----
  CONNECT_VOICE: 'CONNECT_VOICE',
  /** Reserved for future mute-others support. Not yet gated. */
  SPEAK: 'SPEAK',
  /** Reserved for future video-disable support. Not yet gated. */
  VIDEO: 'VIDEO',

  // ---- Wiki ----
  VIEW_WIKI: 'VIEW_WIKI',
  CREATE_WIKI_PAGES: 'CREATE_WIKI_PAGES',
  /** Edit/delete OTHERS' wiki pages, update wiki settings (home page, etc).
   *  Creator-override for own pages is a separate pattern. */
  MANAGE_WIKI: 'MANAGE_WIKI',

  // ---- Events ----
  CREATE_EVENTS: 'CREATE_EVENTS',
  /** Edit/delete OTHERS' events. Creator-override is separate. */
  MANAGE_EVENTS: 'MANAGE_EVENTS',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** All permission strings, for validation and UI iteration. */
export const ALL_PERMISSIONS: readonly Permission[] = Object.values(PERMISSIONS);

/**
 * Default permission sets for the three roles auto-created when a
 * server is created. The migration for existing servers also uses
 * these same sets to populate its default roles.
 *
 * The membership is cumulative: Moderator is @everyone plus a few,
 * Admin is Moderator plus a few. Explicit rather than hierarchical
 * so the runtime check doesn't have to resolve inheritance — each
 * role's permission array is its full granted set.
 */
const EVERYONE_PERMISSIONS: Permission[] = [
  PERMISSIONS.VIEW_CHANNELS,
  PERMISSIONS.SEND_MESSAGES,
  PERMISSIONS.ADD_REACTIONS,
  PERMISSIONS.ATTACH_FILES,
  PERMISSIONS.CREATE_INVITES,
  PERMISSIONS.CONNECT_VOICE,
  PERMISSIONS.SPEAK,
  PERMISSIONS.VIDEO,
  PERMISSIONS.VIEW_WIKI,
  PERMISSIONS.CREATE_WIKI_PAGES,
  PERMISSIONS.CREATE_EVENTS,
];

const MODERATOR_EXTRA: Permission[] = [
  PERMISSIONS.MANAGE_CHANNELS,
  PERMISSIONS.MANAGE_MESSAGES,
  PERMISSIONS.MANAGE_WIKI,
  PERMISSIONS.MANAGE_EVENTS,
  PERMISSIONS.MANAGE_INVITES,
];

const ADMIN_EXTRA: Permission[] = [
  PERMISSIONS.MANAGE_SERVER,
  PERMISSIONS.MANAGE_ROLES,
  PERMISSIONS.KICK_MEMBERS,
];

export const DEFAULT_ROLE_PERMISSIONS = {
  everyone: [...EVERYONE_PERMISSIONS],
  moderator: [...EVERYONE_PERMISSIONS, ...MODERATOR_EXTRA],
  admin: [...EVERYONE_PERMISSIONS, ...MODERATOR_EXTRA, ...ADMIN_EXTRA],
} as const;

/**
 * The names and display colors for the three default roles. Used by
 * both the migration (when backfilling existing servers) and the
 * server-creation flow (when bootstrapping new ones).
 */
/**
 * UI grouping for the permission checkbox grid in the role editor.
 * Order here determines display order in the settings panel. Each
 * group gets a header; permissions within a group appear in the
 * order listed.
 *
 * Kept in the shared module so the client UI and any future role
 * templates read from the same source of truth.
 */
export const PERMISSION_CATEGORIES: ReadonlyArray<{
  id: string;
  label: string;
  permissions: readonly Permission[];
}> = [
  {
    id: 'server',
    label: 'Server administration',
    permissions: [
      PERMISSIONS.MANAGE_SERVER,
      PERMISSIONS.MANAGE_ROLES,
      PERMISSIONS.MANAGE_INVITES,
      PERMISSIONS.KICK_MEMBERS,
      PERMISSIONS.VIEW_AUDIT_LOG,
    ],
  },
  {
    id: 'channels',
    label: 'Channels',
    permissions: [PERMISSIONS.VIEW_CHANNELS, PERMISSIONS.MANAGE_CHANNELS],
  },
  {
    id: 'messages',
    label: 'Messages',
    permissions: [
      PERMISSIONS.SEND_MESSAGES,
      PERMISSIONS.MANAGE_MESSAGES,
      PERMISSIONS.ADD_REACTIONS,
      PERMISSIONS.ATTACH_FILES,
      PERMISSIONS.MENTION_EVERYONE,
      PERMISSIONS.CREATE_INVITES,
    ],
  },
  {
    id: 'voice',
    label: 'Voice',
    permissions: [PERMISSIONS.CONNECT_VOICE, PERMISSIONS.SPEAK, PERMISSIONS.VIDEO],
  },
  {
    id: 'wiki',
    label: 'Wiki',
    permissions: [PERMISSIONS.VIEW_WIKI, PERMISSIONS.CREATE_WIKI_PAGES, PERMISSIONS.MANAGE_WIKI],
  },
  {
    id: 'events',
    label: 'Events',
    permissions: [PERMISSIONS.CREATE_EVENTS, PERMISSIONS.MANAGE_EVENTS],
  },
];

/**
 * Human-readable label for each permission flag, used by the role
 * editor. Keep in sync with `PERMISSIONS` — a lint rule would be
 * nice here but missing labels fall back to the raw flag name.
 */
export const PERMISSION_LABELS: Record<Permission, string> = {
  MANAGE_SERVER: 'Manage server',
  MANAGE_ROLES: 'Manage roles',
  MANAGE_INVITES: 'Manage invites',
  KICK_MEMBERS: 'Kick members',
  VIEW_AUDIT_LOG: 'View audit log (reserved)',
  VIEW_CHANNELS: 'View channels',
  MANAGE_CHANNELS: 'Manage channels',
  SEND_MESSAGES: 'Send messages',
  MANAGE_MESSAGES: "Manage messages (delete others')",
  ADD_REACTIONS: 'Add reactions',
  ATTACH_FILES: 'Attach files',
  MENTION_EVERYONE: 'Mention @everyone (reserved)',
  CREATE_INVITES: 'Create invites',
  CONNECT_VOICE: 'Connect to voice',
  SPEAK: 'Speak in voice (reserved)',
  VIDEO: 'Enable video (reserved)',
  VIEW_WIKI: 'View wiki',
  CREATE_WIKI_PAGES: 'Create wiki pages',
  MANAGE_WIKI: "Manage wiki (edit/delete others')",
  CREATE_EVENTS: 'Create events',
  MANAGE_EVENTS: "Manage events (edit/delete others')",
};

export const DEFAULT_ROLE_DEFINITIONS = [
  {
    name: '@everyone',
    color: null,
    position: 0,
    isDefault: true,
    isSystem: true,
    permissions: DEFAULT_ROLE_PERMISSIONS.everyone,
  },
  {
    name: 'Moderator',
    color: '#22c55e',
    position: 10,
    isDefault: false,
    isSystem: false,
    permissions: DEFAULT_ROLE_PERMISSIONS.moderator,
  },
  {
    name: 'Admin',
    color: '#f59e0b',
    position: 20,
    isDefault: false,
    isSystem: false,
    permissions: DEFAULT_ROLE_PERMISSIONS.admin,
  },
] as const;
