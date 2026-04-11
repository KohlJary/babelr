# Server permissions audit

**Status**: produced during the design phase of the granular permissions + roles
feature (`granular-permissions-core` roadmap item). This is the reference the
PR2 enforcement pass grep/updates against, and the reference the permission
constants file (`packages/shared/src/permissions.ts`) was derived from.

Every distinct server-scoped action that currently checks membership or role,
catalogued from an exhaustive sweep of every route handler and plugin. Grouped
by functional area and ordered within each group from most-privileged to
least-privileged.

## Legend

- **Current check** — literal condition in the code today.
- **Permission** — the flag the PR2 enforcement pass should gate it on.
- **Notes** — creator overrides, owner-only hard-blocks, known bugs.

Checks marked **BUG** currently grant access that should be gated and will be
fixed as part of the enforcement pass.

---

## Server management

| Action | File & handler | Current check | Permission | Notes |
|---|---|---|---|---|
| Update server metadata | `servers.ts` PUT `/servers/:serverId` | owner + admin | `MANAGE_SERVER` | `requireServerAdmin()` checks role OR ownerId |
| Assign role to member | `servers.ts` PUT `/servers/:serverId/members/:userId/role` | owner only | `MANAGE_ROLES` | With new system, any `MANAGE_ROLES` holder can assign (hierarchy enforcement deferred) |
| Kick member | `servers.ts` DELETE `/servers/:serverId/members/:userId` | owner + admin | `KICK_MEMBERS` | Lockout invariant: cannot kick last `MANAGE_ROLES` holder |
| Create invite | `servers.ts` POST `/servers/:serverId/invites` | any member | `CREATE_INVITES` | Default-on for @everyone in new system |
| List invites | `servers.ts` GET `/servers/:serverId/invites` | any member | `MANAGE_INVITES` | **BUG**: no role check today, any member can list |
| Leave server | `servers.ts` POST `/servers/:serverId/leave` | any member except owner | — | Creator-override pattern; unchanged |

**Edge cases preserved from today:**
- Cannot kick the user whose `actorId === server.properties.ownerId`.
- Cannot change the ownerId user's role (ownership transfer is a deferred item).
- Cannot leave the server as the ownerId user.

## Channel management

| Action | File & handler | Current check | Permission | Notes |
|---|---|---|---|---|
| Create channel | `channels.ts` POST `/servers/:serverId/channels` | none | `MANAGE_CHANNELS` | **BUG**: no permission check today, any member can create |
| Update channel | `channels.ts` PUT `/channels/:channelId` | owner + admin + moderator | `MANAGE_CHANNELS` | Covers name, topic, category, slowMode, privacy |
| Delete channel | (not implemented) | — | `MANAGE_CHANNELS` | Reserved for when delete ships |
| List channels | `channels.ts` GET `/servers/:serverId/channels` | any member | `VIEW_CHANNELS` | Filters private channels unless member of them |

**Notes:**
- Private channel membership management stays separate — it's a per-channel
  invite list, not a server-level permission. `MANAGE_CHANNELS` grants the
  ability to *toggle* privacy, not automatic access to every private channel.
- Slow mode bypass (mod+ can post regardless of slow mode): reframed as "users
  with `MANAGE_CHANNELS` bypass slow mode" since that's the role most likely to
  have it.

## Message management

| Action | File & handler | Current check | Permission | Notes |
|---|---|---|---|---|
| Send message | `channels.ts` POST `/channels/:channelId/messages` | channel access | `SEND_MESSAGES` | Slow mode still applies; bypass tied to `MANAGE_CHANNELS` |
| Edit own message | `channels.ts` PUT `/channels/:channelId/messages/:messageId` | creator only | — | Creator-override pattern; no permission flag. Unchanged. |
| Delete own message | `channels.ts` DELETE same path | creator | — | Creator-override allowed regardless of `MANAGE_MESSAGES` |
| Delete others' message | `channels.ts` DELETE same path | creator or mod+ | `MANAGE_MESSAGES` | Non-creator path gated on the permission |
| Add reaction | `channels.ts` POST `/channels/.../reactions` | channel member | `ADD_REACTIONS` | |
| Remove own reaction | `channels.ts` DELETE same path | reaction author only | — | Creator-override pattern |
| Upload attachment | `uploads.ts` POST `/upload` | authenticated | `ATTACH_FILES` | Currently global; tied to server-scope in channel posting context |

## Events (calendar)

| Action | File & handler | Current check | Permission | Notes |
|---|---|---|---|---|
| Create user event | `events.ts` POST `/events` (ownerType=user) | self only | — | User-scoped, not server role |
| Create server event | `events.ts` POST `/events` (ownerType=server) | owner + admin + moderator | `CREATE_EVENTS` | Default-on for @everyone |
| Update own event | `events.ts` PUT `/events/:eventId` | creator | — | Creator-override |
| Update others' event | `events.ts` PUT `/events/:eventId` | creator or mod+ | `MANAGE_EVENTS` | Non-creator path gated |
| Delete own event | `events.ts` DELETE `/events/:eventId` | creator | — | Creator-override |
| Delete others' event | `events.ts` DELETE `/events/:eventId` | creator or mod+ | `MANAGE_EVENTS` | Non-creator path gated |
| Set RSVP | `events.ts` POST `/events/:eventId/rsvp` | server membership | — | Plain membership check, no flag |

## Wiki

| Action | File & handler | Current check | Permission | Notes |
|---|---|---|---|---|
| View wiki page | `wiki.ts` GET `/servers/:serverId/wiki/pages[/...]` | server member | `VIEW_WIKI` | Default-on for @everyone |
| Create wiki page | `wiki.ts` POST `/servers/:serverId/wiki/pages` | server member | `CREATE_WIKI_PAGES` | Default-on for @everyone |
| Edit own wiki page | `wiki.ts` PUT `/servers/:serverId/wiki/pages/:slug` | server member (today) | — | Creator-override. **BUG today**: any member can edit anyone's page. |
| Edit others' wiki page | `wiki.ts` PUT same path | server member (today) | `MANAGE_WIKI` | Non-creator path gated on the permission |
| Delete own wiki page | `wiki.ts` DELETE `/servers/:serverId/wiki/pages/:slug` | creator | — | Creator-override |
| Delete others' wiki page | `wiki.ts` DELETE same path | creator or mod+ | `MANAGE_WIKI` | Non-creator path gated |
| Update wiki settings | `wiki.ts` PUT `/servers/:serverId/wiki/settings` | mod+ | `MANAGE_WIKI` | Sets home page, etc. |

## Voice

| Action | File & handler | Current check | Permission | Notes |
|---|---|---|---|---|
| Join voice channel | `ws.ts` case `voice:join` | channel access | `CONNECT_VOICE` | Default-on for @everyone |
| Speak in voice | WebRTC relay | room participant | `SPEAK` | **Reserved for future** mute-others support |
| Enable video | WebRTC relay | room participant | `VIDEO` | **Reserved for future** video-disable support |
| Voice signaling relay (offer/answer/ice) | `ws.ts` | room participant | — | Not a permission; WebRTC protocol state |

## Friends + DMs (user-scoped, no server role applies)

| Action | Current check | Notes |
|---|---|---|
| Send friend request | authenticated | User-scoped |
| Accept friend request | friendship owner | User-scoped |
| Remove friendship | friendship owner | User-scoped |
| Start DM | authenticated | User-scoped |
| Send DM | DM participant | User-scoped |

**Design decision**: no server permissions model applies to friends/DMs — they
are strictly user-to-user state.

## Read-only / informational (membership-only)

| Action | Current check | Permission | Notes |
|---|---|---|---|
| List servers | authenticated | — | Only shows joined servers |
| Discover servers | authenticated | — | Shows all with a "joined" flag |
| List members | server member | — | Plain membership check |
| List channels | server member | `VIEW_CHANNELS` | Filters private channels unless member |
| Search messages | channel member | — | Uses channel access check |
| Get mentions | authenticated | — | Returns only caller's mentions |
| Mark read | channel member | — | Upserts read position |

These become membership gates with no permission flag required beyond the
implicit "must be a member of the server".

## Reserved permissions (not yet gated on anything)

| Permission | Reason to reserve now |
|---|---|
| `VIEW_AUDIT_LOG` | `granular-permissions-audit-log` follow-up item |
| `MENTION_EVERYONE` | @everyone/@here rate-limited pings, future |
| `SPEAK` | Voice mute-others, future |
| `VIDEO` | Voice video-disable, future |

Listing them in the enum now means we don't have to migrate data when those
features land.

---

## Bugs identified during the audit

All three get fixed in PR2 as part of the enforcement pass — they're included
in the audit here so the fix is explicitly traceable to this doc.

1. **Channel creation has zero permission check**
   (`channels.ts` POST `/servers/:serverId/channels`). Any member can create a
   channel. Should require `MANAGE_CHANNELS`.

2. **Wiki page editing has no role check, only membership**
   (`wiki.ts` PUT `/servers/:serverId/wiki/pages/:slug`). Any server member
   can overwrite anyone's wiki page. Should be creator-override for own pages,
   `MANAGE_WIKI` for others'.

3. **Invite listing has no role check**
   (`servers.ts` GET `/servers/:serverId/invites`). Any member can see every
   invite code the server has ever generated. Should require `MANAGE_INVITES`.

## Patterns to preserve

- **Creator override for own content**: editing/deleting your own messages,
  your own wiki pages, your own events, your own reactions. These remain
  pure `attributedTo === actorId` checks and do NOT map to permission flags.
  The permission flag (`MANAGE_MESSAGES`, `MANAGE_WIKI`, `MANAGE_EVENTS`)
  only gates the non-creator path.

- **Owner lockout prevention**: replaced by the lockout invariant
  (see `granular-permissions-core` roadmap item and the
  `ensureManageRolesSurvives` helper). After any mutation that could reduce
  the set of `MANAGE_ROLES` holders, the server must still have at least one.

- **Membership gate**: actions like marking a channel as read or listing the
  member list remain pure membership checks, not permission checks. The shape
  is "is this actor in the server's followers collection?".

## Second-audit checklist (PR2)

After the enforcement pass, grep to verify:

```bash
# No remaining hardcoded role-string array checks
rg "\['owner', 'admin'" packages/server/src/
rg "\['owner', 'admin', 'moderator'\]" packages/server/src/
rg '"role"\s*===\s*"admin"' packages/server/src/

# Every server-scoped action goes through hasPermission
rg "hasPermission\(" packages/server/src/routes/
```

The grep should return zero matches on the first two patterns. The third
should return exactly one match per row in the tables above (plus a few for
the lockout invariant helper itself).
