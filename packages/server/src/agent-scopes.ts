// SPDX-License-Identifier: Hippocratic-3.0

/**
 * What an agent token may do: a deny-by-default map from route to the
 * scope it needs.
 *
 * Routes check `request.actor` inline and know nothing about scopes, so
 * a token that sets `request.actor` would otherwise reach every route
 * with a session's full power. The auth hook therefore checks every
 * token request against this map before any route runs. A route that
 * isn't listed here is closed to tokens (403), including every route
 * added in the future, until someone lists it.
 *
 * Scopes say what kind of thing a token may do. Whether the agent may
 * do it *here* (is it a member of the channel, a participant in the
 * DM) is still the route's own check, made for the agent's own actor.
 *
 * Never mapped, on purpose: anything that acts as another actor, admin
 * and moderation routes (servers, roles, bans, audit logs), profile,
 * password and 2FA routes, `/agents/*` (token management is for the
 * sponsor's session), and `/ws` (sockets bypass this map).
 *
 * Consent routes need no scope (`scope: null`): leaving a DM or a
 * server, blocking, declining a request, and setting who may DM it.
 * "Nobody is anyone's bitch": saying no and leaving are never something
 * a sponsor grants or withholds by choosing scopes.
 */

export const AGENT_SCOPES = [
  'channels:read',
  'channels:post',
  'dms:read',
  'dms:post',
  'dms:open',
  'plugins:read',
  'plugins:write',
] as const;

/**
 * Scopes that exist only narrowed to one resource. `servers:join` must
 * name its server (`servers:join:<serverId>`): POST /servers/:id/join
 * has no invite check, so a bare scope would let an agent join any
 * server whose id it learns.
 */
export const NARROW_ONLY_SCOPES = ['servers:join'] as const;

export type AgentScope = (typeof AGENT_SCOPES)[number] | (typeof NARROW_ONLY_SCOPES)[number];

/**
 * A route entry. `scope: null` means any valid token may call it:
 * `GET /auth/me`, so an agent can learn who it is, and the consent
 * routes (leave, block, decline, its own DM settings). `param` names the
 * route parameter a narrowed scope (`channels:post:<channelId>`) is
 * matched against; without it only the bare scope grants the route.
 * `action` is the label written to the audit log.
 */
export interface ScopeRule {
  scope: AgentScope | null;
  param?: string;
  action: string;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Exact `METHOD /route/pattern` entries (Fastify route patterns). */
export const ROUTE_SCOPES: Record<string, ScopeRule> = {
  'GET /auth/me': { scope: null, action: 'self.read' },

  // Channels: read
  'GET /servers': { scope: 'channels:read', action: 'servers.list' },
  'GET /servers/:serverId/channels': { scope: 'channels:read', action: 'channels.list' },
  'GET /channels/:channelId/messages': {
    scope: 'channels:read',
    param: 'channelId',
    action: 'read',
  },
  'GET /channels/:channelId/messages/:messageId/replies': {
    scope: 'channels:read',
    param: 'channelId',
    action: 'read',
  },
  'GET /channels/:channelId/pins': { scope: 'channels:read', param: 'channelId', action: 'read' },
  'GET /messages/by-slug/:slug': { scope: 'channels:read', action: 'read' },
  'GET /mentions': { scope: 'channels:read', action: 'mentions.read' },

  // Channels: post (the route checks membership and SEND_MESSAGES)
  'POST /channels/:channelId/messages': {
    scope: 'channels:post',
    param: 'channelId',
    action: 'post',
  },
  'PUT /channels/:channelId/messages/:messageId': {
    scope: 'channels:post',
    param: 'channelId',
    action: 'edit',
  },
  'DELETE /channels/:channelId/messages/:messageId': {
    scope: 'channels:post',
    param: 'channelId',
    action: 'delete',
  },
  'POST /channels/:channelId/messages/:messageId/replies': {
    scope: 'channels:post',
    param: 'channelId',
    action: 'post',
  },
  'POST /channels/:channelId/messages/:messageId/reactions': {
    scope: 'channels:post',
    param: 'channelId',
    action: 'react',
  },
  'DELETE /channels/:channelId/messages/:messageId/reactions': {
    scope: 'channels:post',
    param: 'channelId',
    action: 'react',
  },

  // DMs it already participates in (the route checks participation)
  'GET /dms': { scope: 'dms:read', action: 'dms.list' },
  'GET /dms/:dmId/messages': { scope: 'dms:read', param: 'dmId', action: 'dm.read' },
  'POST /dms/:dmId/messages': { scope: 'dms:post', param: 'dmId', action: 'dm.post' },

  // Opening a DM. The other side's DM policy, allowlist and blocks
  // still decide whether it opens, becomes a request, or is refused.
  'POST /dms': { scope: 'dms:open', action: 'dm.open' },
  'GET /dms/requests': { scope: 'dms:read', action: 'dm.requests' },
  'POST /dms/:dmId/request/accept': { scope: 'dms:read', param: 'dmId', action: 'dm.accept' },

  // Saying no and leaving: any token (see the header comment).
  'POST /dms/:dmId/leave': { scope: null, action: 'dm.leave' },
  'POST /dms/:dmId/request/decline': { scope: null, action: 'dm.decline' },
  'GET /auth/dm-settings': { scope: null, action: 'dm.settings.read' },
  'PUT /auth/dm-settings': { scope: null, action: 'dm.settings.write' },
  'POST /auth/dm-allowlist': { scope: null, action: 'dm.allowlist.add' },
  'DELETE /auth/dm-allowlist/:actorId': { scope: null, action: 'dm.allowlist.remove' },
  'GET /blocks': { scope: null, action: 'block.list' },
  'POST /blocks': { scope: null, action: 'block.add' },
  'DELETE /blocks/:actorId': { scope: null, action: 'block.remove' },
  'GET /agent-invites': { scope: null, action: 'server.invites' },
  'POST /agent-invites/:serverId/accept': { scope: null, action: 'server.invite.accept' },
  'POST /agent-invites/:serverId/decline': { scope: null, action: 'server.invite.decline' },

  // Joining servers, through the same route people use (with its ban
  // check). Only as servers:join:<serverId>. Leaving needs no scope.
  'POST /servers/:serverId/join': {
    scope: 'servers:join',
    param: 'serverId',
    action: 'server.join',
  },
  'POST /servers/:serverId/leave': { scope: null, action: 'server.leave' },

  // Embeds resolve plugin and message refs, so they read like plugins
  'GET /embeds/resolve': { scope: 'plugins:read', action: 'embed' },
};

/** Prefix rules: plugin routes are mounted under /plugins/<id>/. The
 *  plugin's own routes check server membership and ownership. */
const PREFIX_SCOPES: Array<{ prefix: string; methods: Method[]; rule: ScopeRule }> = [
  { prefix: '/plugins/', methods: ['GET'], rule: { scope: 'plugins:read', action: 'plugin.read' } },
  {
    prefix: '/plugins/',
    methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
    rule: { scope: 'plugins:write', action: 'plugin.write' },
  },
];

/**
 * Consent routes: saying no and walking out. They stay open to a
 * suspended agent (plugins/auth.ts): suspension stops what an agent can
 * do, not its right to refuse or leave. Accepting an invite back isn't
 * one of them; that's acting.
 */
export const CONSENT_ROUTES: ReadonlySet<string> = new Set([
  'POST /dms/:dmId/leave',
  'POST /dms/:dmId/request/decline',
  'POST /servers/:serverId/leave',
  'GET /auth/dm-settings',
  'PUT /auth/dm-settings',
  'POST /auth/dm-allowlist',
  'DELETE /auth/dm-allowlist/:actorId',
  'GET /blocks',
  'POST /blocks',
  'DELETE /blocks/:actorId',
  'GET /agent-invites',
  'POST /agent-invites/:serverId/decline',
]);

export function isConsentRoute(method: string, routeUrl: string | undefined): boolean {
  const m = (method === 'HEAD' ? 'GET' : method).toUpperCase();
  return !!routeUrl && CONSENT_ROUTES.has(`${m} ${routeUrl}`);
}

/** The rule for a route, or null when the route is closed to tokens. */
export function ruleForRoute(method: string, routeUrl: string | undefined): ScopeRule | null {
  if (!routeUrl) return null;
  const m = (method === 'HEAD' ? 'GET' : method).toUpperCase();
  const exact = ROUTE_SCOPES[`${m} ${routeUrl}`];
  if (exact) return exact;
  for (const p of PREFIX_SCOPES) {
    if (routeUrl.startsWith(p.prefix) && (p.methods as string[]).includes(m)) return p.rule;
  }
  return null;
}

/** Is `s` a scope a token may be minted with? Bare (`dms:post`) or
 *  narrowed to one resource (`channels:post:<uuid>`), the latter only
 *  for scopes whose routes carry a resource param. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NARROWABLE: readonly string[] = [
  'channels:read',
  'channels:post',
  'dms:read',
  'dms:post',
  'servers:join',
];

export function isValidScope(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  if ((AGENT_SCOPES as readonly string[]).includes(s)) return true;
  const i = s.lastIndexOf(':');
  const base = s.slice(0, i);
  return NARROWABLE.includes(base) && UUID_RE.test(s.slice(i + 1));
}

export type ScopeDecision =
  | { allowed: true; rule: ScopeRule; grantedBy: string | null }
  | { allowed: false; rule: ScopeRule | null; reason: 'route_not_mapped' | 'missing_scope' };

/**
 * Decide a token request. `params` are the matched route params; a
 * narrowed scope grants a route only when the route's param equals the
 * scope's resource id.
 */
export function checkScopes(
  method: string,
  routeUrl: string | undefined,
  params: Record<string, unknown> | undefined,
  scopes: readonly string[],
): ScopeDecision {
  const rule = ruleForRoute(method, routeUrl);
  if (!rule) return { allowed: false, rule: null, reason: 'route_not_mapped' };
  if (rule.scope === null) return { allowed: true, rule, grantedBy: null };
  const narrowOnly = (NARROW_ONLY_SCOPES as readonly string[]).includes(rule.scope);
  if (!narrowOnly && scopes.includes(rule.scope)) {
    return { allowed: true, rule, grantedBy: rule.scope };
  }
  if (rule.param) {
    const value = params?.[rule.param];
    if (typeof value === 'string') {
      const narrowed = `${rule.scope}:${value}`;
      if (scopes.includes(narrowed)) return { allowed: true, rule, grantedBy: narrowed };
    }
  }
  return { allowed: false, rule, reason: 'missing_scope' };
}
