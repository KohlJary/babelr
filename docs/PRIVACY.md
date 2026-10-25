# Privacy

Babelr's privacy story is structural, not promissory. The architecture makes it technically impossible for the server to access certain categories of data.

## What the server stores

- **User accounts** -- Username, email, hashed password (argon2), preferred language, public encryption key
- **Server channel messages** -- Plaintext content, author, timestamp, channel
- **DM messages** -- **Ciphertext only.** The server refuses a DM message, thread reply, edit or federated DM that isn't encrypted, and stores the encrypted blobs it can't decrypt. Attachments are the exception (see Limitations).
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

| Property          | Value                                                                  |
| ----------------- | ---------------------------------------------------------------------- |
| Key exchange      | ECDH P-256                                                             |
| Symmetric cipher  | AES-256-GCM                                                            |
| IV                | 12 bytes, random per message                                           |
| Key storage       | IndexedDB (CryptoKey object, same-origin protected)                    |
| Public key format | JWK, stored on server                                                  |
| Implementation    | Web Crypto API (no third-party crypto libraries)                       |
| Agent accounts    | `packages/agent-client-py`, byte-compatible, tested against Web Crypto |

## Limitations

- **Server channel messages are not encrypted.** Only DMs have E2E encryption. This is a deliberate choice for Phase 1 to simplify moderation. The architecture does not preclude encrypting channel messages in the future.
- **Private group rooms are not encrypted yet.** DMs are one-to-one and use a pairwise key. Private channels have no group-key scheme, so the server can't require encryption there without breaking them. The design is in [e2e-private-rooms.md](e2e-private-rooms.md).
- **Private key is per-device.** A new browser makes a new key pair and publishes it, replacing the old public key. Messages sent after that can't be read on the old device, and old messages can't be read on the new one. Multi-device key sync is planned for a future release.
- **The server vouches for public keys, and nobody checks it yet.** Clients fetch a partner's public key from the server. A malicious operator could hand out its own key and read new DMs. There are no key fingerprints or key-change warnings yet. E2E here protects against a database leak, federation peers and other members; it doesn't protect against whoever runs the server, or the machine that holds a private key.
- **DM attachments aren't encrypted.** Files go to `/uploads` as-is, and their filename and type sit in the message's metadata.
- **No forward secrecy.** One key pair per actor, so a stolen private key reads every DM sent to it.
- **Translation proxy sees content in transit** (but does not store it). Use the local browser translation provider to eliminate this entirely.
