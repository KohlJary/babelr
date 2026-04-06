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
