# Babelr

**Keep your language. The routing layer handles the rest.**

Babelr is a federated chat system with a tone-preserving LLM translation layer at its core. Users write in their native language; recipients read in theirs. The translation pipeline treats register, idiom, humor, and intent shape as first-class concerns, not afterthoughts.

The name is a statement. The Tower of Babel story is usually read as punishment for human hubris, but structurally it is a story about power fragmenting a communication layer that threatened incumbents. Babelr is infrastructure that makes linguistic difference navigable without erasing it.

Structurally closer to Pentecost than to Esperanto: everyone hearing in their own native tongue.

## Features

**Tone-preserving translation** -- Not "translate X to French" but "translate X to French preserving the casual-affectionate register and the self-deprecating joke structure." Every translation carries a metadata envelope: detected register, intent classification, confidence score, and flagged idioms with hover-gloss explanations.

**End-to-end encrypted DMs** -- Client-side ECDH P-256 key exchange with AES-256-GCM encryption. The server never sees DM plaintext. Translation runs after local decryption.

**Browser-local inference** -- No API key? No problem. Translations run entirely in the browser via Transformers.js with Helsinki-NLP OPUS models. Reduced quality compared to cloud translation, but works offline after first model download.

**ActivityPub-shaped from day one** -- The data model uses ActivityPub primitives (Actors, Objects, Activities, Collections) even though federation is not yet active. When it activates, it is a flip, not a rewrite.

**Discord-shaped UX** -- Servers, channels, DMs, real-time WebSocket messaging. Three-panel layout with server sidebar, channel list, and chat area.

**Hippocratic License** -- Universal translation is infrastructure for human flourishing, not a commodity to be metered. The [Hippocratic License 3.0](LICENSE.md) structurally excludes surveillance and human-rights-violating deployments.

## Quick Start

```bash
# Clone and install
git clone https://github.com/YOUR_USERNAME/babelr.git
cd babelr
npm install

# Set up environment
cp .env.example .env
# Edit .env: set DATABASE_URL and SESSION_SECRET

# Set up database (requires PostgreSQL)
createdb babelr
npm run db:migrate

# Start development
npm run dev:server   # Terminal 1: API server on :3000
npm run dev:client   # Terminal 2: Vite dev server on :5173
```

Open `http://localhost:5173`, register an account, and start chatting.

For Docker deployment, see [Self-Hosting Guide](docs/SELF_HOST.md).

## Architecture

```
                          Client (React)
                    +-----------------------+
                    |  Translation Layer    |
                    |  (client-side only)   |
                    |                       |
                    |  Cloud: Anthropic API |
                    |  Local: Transformers.js|
                    |                       |
                    |  E2E Crypto (DMs)     |
                    |  ECDH + AES-GCM      |
                    +-----------+-----------+
                                |
                         REST + WebSocket
                                |
                    +-----------+-----------+
                    |     Server (Fastify)   |
                    |                       |
                    |  Auth (sessions)      |
                    |  Channels & DMs       |
                    |  WS broadcast         |
                    |  Translation proxy    |
                    |  (CORS passthrough)   |
                    +-----------+-----------+
                                |
                    +-----------+-----------+
                    |   PostgreSQL          |
                    |                       |
                    |  actors (Person/Group)|
                    |  objects (Note/Coll.) |
                    |  activities (AP log)  |
                    |  collection_items     |
                    |  sessions             |
                    +-----------------------+
```

The server stores only original-language messages. For DMs, it stores only ciphertext. Translation happens client-side. The privacy story is structural, not promissory.

See [Architecture docs](docs/ARCHITECTURE.md) for details.

## Translation Pipeline

The three-stage pipeline runs as a single LLM call:

1. **Classify** -- Register (casual/formal/sarcastic/technical/affectionate/neutral) and intent (statement/question/joke/correction/greeting/reference)
2. **Translate** -- With register and intent as explicit constraints. Jokes must land as jokes. Sarcasm must read as sarcasm.
3. **Idiom check** -- Flag untranslatable expressions with explanation and target-language equivalent

Every message displays a metadata badge showing what the system understood.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | TypeScript, Fastify 5, Drizzle ORM |
| Database | PostgreSQL |
| Frontend | React 19, Vite |
| Real-time | WebSocket (@fastify/websocket) |
| Translation (cloud) | Anthropic Claude API (user's own key) |
| Translation (local) | Transformers.js, Helsinki-NLP OPUS models |
| Encryption | Web Crypto API (ECDH P-256 + AES-256-GCM) |
| Monorepo | npm workspaces |

## Documentation

- [Self-Hosting Guide](docs/SELF_HOST.md) -- Docker and manual deployment
- [Architecture](docs/ARCHITECTURE.md) -- Data model, translation pipeline, E2E crypto
- [Privacy](docs/PRIVACY.md) -- What data is stored, what isn't, and why
- [Contributing](CONTRIBUTING.md) -- How to contribute

## License

Babelr is licensed under the [Hippocratic License 3.0](LICENSE.md) (HL3-FULL).

This means you are free to use, modify, and distribute this software, provided you comply with the ethical standards defined in the license. These include prohibitions on human rights violations, mass surveillance, and environmental destruction.

Universal translation is uniquely dangerous if inverted for surveillance. The license is not an afterthought -- it is a structural commitment.

Copyright (c) 2026 Kohl Jary and contributors
