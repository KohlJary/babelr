# Privacy

Babelr's privacy story is structural, not promissory. The architecture makes it technically impossible for the server to access certain categories of data.

## What the server stores

- **User accounts** -- Username, email, hashed password (argon2), preferred language, public encryption key
- **Server channel messages** -- Plaintext content, author, timestamp, channel
- **DM messages** -- **Ciphertext only.** The server stores encrypted blobs and cannot decrypt them.
- **ActivityPub metadata** -- URIs, activity log (who created what, who joined which server)
- **Sessions** -- Session ID, actor reference, expiry timestamp

## What the server never sees

- **Translated content** -- Translation runs entirely client-side. The server stores only the original-language message.
- **DM plaintext** -- DM content is end-to-end encrypted before leaving the client. The server stores AES-GCM ciphertext.
- **API keys** -- Users' Anthropic API keys are stored in the browser's localStorage and sent directly to the translation proxy. The proxy forwards them to Anthropic without storing them.
- **Encryption private keys** -- ECDH private keys are stored in the browser's IndexedDB and never transmitted.

## Translation proxy

The server provides a `POST /translate` endpoint that proxies requests to the Anthropic API to bypass CORS restrictions. The proxy:

- Forwards the user's API key and message content to Anthropic
- Returns the response to the client
- Does **not** log, store, or inspect the content
- Requires authentication (session cookie)

This is a pragmatic concession for Phase 1. The long-term goal (browser-local inference via Transformers.js, already available) eliminates the proxy entirely.

## Telemetry

Babelr collects no telemetry, analytics, or usage data. There are no tracking pixels, no third-party scripts, no ad networks. The only network requests are to the Babelr server itself and (optionally) to the Anthropic API for translation.

## Data portability

All data is stored in PostgreSQL with a well-documented ActivityPub-shaped schema. Users can request a full export of their data via standard database queries. The schema is designed for federation -- future versions will support ActivityPub data portability natively.

## Encryption details

| Property | Value |
|----------|-------|
| Key exchange | ECDH P-256 |
| Symmetric cipher | AES-256-GCM |
| IV | 12 bytes, random per message |
| Key storage | IndexedDB (CryptoKey object, same-origin protected) |
| Public key format | JWK, stored on server |
| Implementation | Web Crypto API (no third-party crypto libraries) |

## Limitations

- **Server channel messages are not encrypted.** Only DMs have E2E encryption. This is a deliberate choice for Phase 1 to simplify moderation. The architecture does not preclude encrypting channel messages in the future.
- **Private key is per-device.** If a user logs in from a new browser, they cannot decrypt old DM messages. Multi-device key sync is planned for a future release.
- **Translation proxy sees content in transit** (but does not store it). Use the local browser translation provider to eliminate this entirely.
