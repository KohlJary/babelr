# Architecture

## Overview

Babelr is a monorepo with three packages:

- **`@babelr/shared`** -- TypeScript types shared between server and client
- **`@babelr/server`** -- Fastify backend with PostgreSQL
- **`@babelr/client`** -- React frontend with Vite

The server handles auth, messaging, and real-time delivery. Translation happens entirely client-side. The server never sees translated content or DM plaintext.

## Data Model (ActivityPub)

The database uses ActivityPub primitives from day one, even though federation is not yet active.

| Concept | AP Type | Table | Key Fields |
|---------|---------|-------|------------|
| User | Person Actor | `actors` | preferredUsername, email, passwordHash, preferredLanguage |
| Server (guild) | Group Actor | `actors` | displayName, properties.ownerId |
| Channel | OrderedCollection | `objects` | belongsTo (server), properties.name |
| Message | Note | `objects` | content, context (channel), attributedTo (author) |
| DM conversation | OrderedCollection | `objects` | belongsTo=null, properties.isDM=true |
| Activity log | Activity | `activities` | type (Create/Follow/etc), actorId, objectUri |
| Membership | Collection item | `collection_items` | collectionUri, itemUri |
| Wiki page | (future: Article) | `wiki_pages` | serverId, slug, title, content, revisions history |
| Wiki link | --- | `wiki_page_links` | bidirectional page↔page and message↔page link graph |

ActivityPub URIs are generated for all actors and objects, following the pattern `https://{domain}/users/{username}`, `https://{domain}/groups/{slug}`, etc.

## Message Flow

### Server Channel Messages

```
User types message
  -> POST /channels/:id/messages { content }
  -> Server stores Note in objects table (plaintext)
  -> Server creates Create activity
  -> Server broadcasts via WebSocket to subscribed clients
  -> Clients receive, translate client-side, render
```

### DM Messages (E2E Encrypted)

```
User types message
  -> Client encrypts: ECDH derive shared key + AES-GCM encrypt
  -> POST /dms/:id/messages { content: base64_ciphertext, properties: { encrypted, iv } }
  -> Server stores ciphertext (cannot read it)
  -> Server broadcasts ciphertext via WebSocket
  -> Recipient decrypts: ECDH derive shared key + AES-GCM decrypt
  -> Decrypted plaintext passed to translation pipeline
  -> Translated message rendered
```

## Translation Pipeline

Two providers, user-selectable:

### Cloud (Anthropic Claude)

Three-stage prompt executed in a single API call:

1. **Classify** -- Register (casual/formal/sarcastic/technical/affectionate/neutral) and intent (statement/question/joke/correction/greeting/reference)
2. **Translate** -- With register and intent as explicit constraints
3. **Idiom check** -- Flag untranslatable expressions with glosses

Returns structured metadata envelope alongside the translated text.

The server provides a thin CORS proxy (`POST /translate`) that forwards the user's API key and messages to Anthropic. The proxy does not log or store content.

### Local (Transformers.js)

Browser-local inference using Helsinki-NLP OPUS models (~50MB per language pair). No API key needed. Produces basic translations without the metadata envelope (no register/intent/idiom analysis).

Models are cached in the browser's Cache Storage after first download.

## Wikis

Per-server long-form knowledge base. Three tables:

| Table | Purpose |
|-------|---------|
| `wiki_pages` | One row per page. Keyed by `(serverId, slug)`. Stores markdown content, author, last-editor, timestamps. |
| `wiki_page_revisions` | Append-only edit history. One row per write (create + every update). Monotonic `revisionNumber` per page. UI for browsing history is deferred. |
| `wiki_page_links` | Bidirectional link graph. One row per "source references target" edge. Per-source-type FK columns (`sourcePageId` / `sourceMessageId`) so deletes cascade cleanly. |

Routes live at `/servers/:serverId/wiki/pages/...`. Read access requires server membership; creators can delete their own pages; mods+ can delete any. The permission helper (`getServerRole`) mirrors the events.ts membership/role lookup pattern.

### `[[slug]]` reference resolution

Shared parser (`packages/shared/src/wiki-links.ts`) extracts `[[slug]]`, `[[Title]]`, and `[[slug|display]]` refs from markdown content. Used by both server (to sync `wiki_page_links` rows) and client (to rewrite refs into `[display](#wiki/slug)` markdown links at render time).

Link sync fires on every write:

- **Wiki page create/update**: `syncPageOutboundLinks` deletes the page's outgoing rows and re-inserts them from the parsed refs. Self-loops filtered.
- **Message create/edit** (`wiki-link-sync.ts`): resolves the owning server from the channel's `belongsTo`, then writes/rewrites the message's outgoing rows. No-op for DMs (wiki pages are server-scoped).

Unresolved slugs are silently dropped — the link will auto-resolve on the next re-sync when the target page exists. This keeps the invariant "every row in `wiki_page_links` points at a live page" without ever needing a GC pass.

A global click handler on the client (`ChatView`) intercepts anchor clicks to `#wiki/<slug>` and opens the WikiPanel at that slug instead of letting the browser navigate. The WikiPanel has its own local click handler so refs clicked within the panel navigate in place rather than re-opening.

### Translation: paragraph chunking

Wiki content flows through the same `/translate` endpoint that messages use, but with two wiki-specific wrappers on the client:

**Chunker** (`packages/shared/src/wiki-chunker.ts`) splits a page's markdown into an ordered stream of `{prose, code, blank}` chunks. Line-based state machine: triple-backtick fences toggle `code` mode, blank lines emit `blank`, everything else accumulates into `prose` paragraphs. Reassembly preserves the original newline structure.

**Hook** (`packages/client/src/hooks/useWikiTranslation.ts`) hashes each prose chunk, checks the cache, batches uncached chunks into a single translate call, and reassembles. Per-chunk hashing means:

- Mixed-language pages translate correctly — each chunk's source language is detected independently by the Stage-1 classifier.
- Edits only retranslate the paragraph that actually changed — the rest pull from cache.
- Code fences are never sent to the translator.
- Cache hits persist across sessions (see below).

### Translation cache

`packages/client/src/translation/cache.ts` provides two APIs:

- **Legacy**: `getCached(messageId, lang)` / `setCached(messageId, lang, entry)` — used by `useTranslation` for chat messages. Keys by message id since messages are effectively immutable post-send.
- **Hashed**: `getCachedByHash(kind, hash, lang)` / `setCachedByHash(kind, hash, lang, entry)` — used by wiki. Keys by content hash (FNV-1a 32-bit) + target language + content kind. Mutable content auto-invalidates because the hash changes when the content does.

Both APIs back onto the same localStorage-persisted store. One key per entry (`babelr:tx:<kind>:<hash|id>:<lang>`), with an explicit index key (`babelr:tx:index`) for cheap LRU eviction. Bounded at 2000 entries; oldest evicted when exceeded. Quota errors during persist are swallowed so the in-memory layer keeps working.

The hashed API is designed to extend to messages and DMs in a follow-up PR — the `ContentKind` enum already includes `'dm'`.

## E2E Encryption

DMs use ECDH P-256 key exchange with AES-256-GCM, all via the Web Crypto API:

- Each user generates an ECDH keypair on first use
- Public keys stored on the server in `actors.properties.publicKey` (JWK)
- Private keys stored in the browser's IndexedDB (never leave the device)
- Shared secret derived: `ECDH(myPrivateKey, theirPublicKey) -> AES-GCM key`
- ECDH is symmetric: both parties derive the same shared key
- Each message gets a random 12-byte IV

## Real-Time

WebSocket connection (`/ws`) authenticated via session cookie. Protocol:

```
Server -> Client:
  { type: "connected", payload: { actorId } }
  { type: "message:new", payload: { message, author } }
  { type: "error", payload: { message } }

Client -> Server:
  { type: "channel:subscribe", payload: { channelId } }
  { type: "channel:unsubscribe", payload: { channelId } }
```

Subscription tracking is in-memory (`Map<channelId, Set<WebSocket>>`). Single-process only; multi-process would need Redis pub/sub.

## Auth

Session-based with secure httpOnly cookies. Passwords hashed with argon2 (PHC winner, memory-hard). Sessions stored in PostgreSQL with 30-day expiry.
