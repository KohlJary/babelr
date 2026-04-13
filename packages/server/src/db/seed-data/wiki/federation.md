# Federation & Towers

Babelr Towers federate via ActivityPub. Each organization runs their own Tower, and Towers communicate across the internet with HTTP-signed activity delivery.

## What Is a Tower?

A Tower is a Babelr deployment — the running instance at a hostname like `chat.example.com`. Everything inside a Tower (servers, channels, wiki, calendar, files, users) is managed by that Tower's administrators.

"Server" means something different: it's a community within a Tower, like a Discord server. A single Tower can host many servers.

## What Federates

Every content surface crosses Tower boundaries:

- **Friend requests** — add users on other Towers by handle (`alice@partner.com`)
- **Direct messages** — end-to-end encrypted, even across Towers
- **Server membership** — join a server on another Tower via the remote join dialog
- **Channel messages** — post and receive in real time across Towers
- **Message edits, deletes, reactions** — propagate instantly
- **Wiki pages** — create, edit, delete sync to remote members
- **Calendar events** — create, edit, RSVP across Towers
- **Server files** — metadata and directory structure sync; binaries serve from the origin
- **Profile updates** — display name, avatar, bio changes reach your friends on other Towers
- **Server metadata** — name, description, logo changes propagate to remote members

## Cross-Tower Embeds

The `[[server@tower:kind:slug]]` syntax lets you reference content on another Tower:

```
[[engineering@partner.com:wiki:api-spec]]
```

This resolves via a signed federation proxy, renders inline with a purple origin badge, and translates into your language.

## How It Works

1. **WebFinger** discovers actors across Towers (`alice@partner.com` → actor URI)
2. **HTTP Signatures** authenticate every cross-Tower request (RSA-SHA256, request-target + host + date + digest)
3. **Delivery queue** handles retry with exponential backoff (30s → 60s → 120s → 240s)
4. **Shadow objects** cache remote content locally (channels, wiki pages, events, files) so the UI renders without waiting for the origin
5. **Auto-sync** refreshes shadow content on each view so changes appear without re-joining

## Setting Up Federation

Set `BABELR_DOMAIN` to your Tower's public hostname before creating any content. This value is baked into every ActivityPub URI — changing it later breaks existing federation relationships.

Behind a reverse proxy with TLS:

```
BABELR_DOMAIN=chat.example.com
NODE_ENV=production
```
