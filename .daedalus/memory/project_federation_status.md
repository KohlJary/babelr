---
name: Federation implementation status
description: Current state of ActivityPub federation — what works, what's next, key patterns established
type: project
originSessionId: 173c999b-e4bd-4c2c-b113-6b1a648ba383
---
## What federates today (as of 2026-04-12)

All working end-to-end between two local instances via `./scripts/dev-two-instance.sh`:
- **Actor discovery** via WebFinger (http in dev, https in prod)
- **Friend requests** — Follow/Accept/Undo with real-time WS events
- **Cross-instance DMs** — including E2E encryption fields, read receipts, conversation:new
- **Server join/leave** — Group Follow (auto-accept), Undo(Follow) on leave
- **Channel discovery** — auto-sync on listing via GET /groups/:slug/channels
- **Channel messages** — Create via Group inbox relay, context URI resolution to shadow channels
- **Threaded replies** — inReplyTo serialized/resolved across instances
- **Message edits + deletes** — Update/Delete via Group relay, message:updated/message:deleted WS events
- **Emoji reactions** — Like/Undo(Like) via Group relay
- **Profile updates** — Update(Actor) to friends, live WS friend:updated events
- **Message slugs** — babelrSlug carried in AP payload, enables [[msg:slug]] embeds cross-instance
- **Embed proxy** — by-slug falls back to origin server for pre-join messages
- **Private channel invites** — Add(OrderedCollection) to remote user's inbox
- **Remote member list** — GET /groups/:slug/members proxied from origin
- **Signature key refresh** — automatic re-fetch on verification failure (handles key rotation)
- **Cross-origin uploads** — CORP set to cross-origin for federated avatar/attachment loading

## Key patterns established

- **Remote vs local Group detection**: channel.belongsTo → actors.local determines delivery path
- **Remote channel**: deliver Create to Group inbox; **local channel**: broadcastToGroupFollowers
- **Group is outer actor**: Group signs and claims the activity; Note's attributedTo preserves real author
- **Shadow objects**: remote channels cached as local OrderedCollection rows with remote URI
- **Context URI resolution**: inbound Notes map context URI → shadow channel ID for WS routing

## What's next (agreed direction: A then B)

**Option A remaining (federation hardening):**
- `federation-signed-proxy-requests` (P1) — replace unauthenticated proxy GETs with HTTP-signed requests. Three endpoints to secure: by-slug, channels, members. Needs a signedGet helper and verification on receiving endpoints.
- `federation-channel-sync` (P1) — push-based channel lifecycle. Auto-refresh on listing already covers UX; push adds real-time channel appearance. Lower priority than signed proxy.

**Option B (self-hosted deployment):**
- `self-hosted-onprem-package` (P2) — Docker Compose setup, `.env` template, reverse proxy config. Critical for letting anyone else run the project.

## Federation testing infrastructure

- `./scripts/dev-two-instance.sh` — four-process launcher (two servers, two vite clients)
- `./scripts/reset-federation-dbs.sh` — wipe and recreate both test databases
- `docs/FEDERATION_TESTING.md` — 15-section manual test checklist
- `/etc/hosts` aliases: `babelr-a.local`, `babelr-b.local` pointing to 127.0.0.1
- Vite config: `VITE_DEV_PORT` and `VITE_PROXY_TARGET` env vars for multi-instance
