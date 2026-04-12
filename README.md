# Babelr

**Keep your language. The routing layer handles the rest.**

Babelr is a federated workspace — chat, wiki, and calendar — built around a tone-preserving LLM translation layer. Users write in their native language and recipients read in theirs, but translation is the thread rather than the destination. What makes Babelr cohere is the substrate underneath it: messages, wiki pages, and calendar events all reference each other through a single `[[kind:slug]]` embed fabric. A wiki page can cite the chat message where a decision was made. A calendar event can link to the runbook it's briefing. A chat thread can invite readers directly into an event's RSVP list with a single click. The surfaces stop feeling like separate tools and start behaving like one connected space.

The translation pipeline treats register, idiom, humor, and intent shape as first-class concerns across every surface — the runbook you wrote in English and the meeting invite your colleague wrote in Japanese both land in each reader's preferred language with their voice intact. Federation is ActivityPub-shaped from day one, so a partner company on their own Babelr instance can follow a channel, read a wiki page, or RSVP to a calendar event without leaving their home server. Very few workspaces can offer even two of those three at once.

The name is a statement. The Tower of Babel story is usually read as punishment for human hubris, but structurally it is a story about power fragmenting a communication layer that threatened incumbents. Babelr is infrastructure that makes linguistic difference navigable without erasing it.

Structurally closer to Pentecost than to Esperanto: everyone hearing in their own native tongue.

## Features

**Tone-preserving translation** -- Not "translate X to French" but "translate X to French preserving the casual-affectionate register and the self-deprecating joke structure." Every translation carries a metadata envelope: detected register, intent classification, confidence score, and flagged idioms with hover-gloss explanations.

**Server wikis with mixed-language translation** -- Long-form knowledge that persists outside the chat stream, and the first wiki system in any chat platform where a single page can be authored in five languages and read natively in any sixth. Bidirectional links between wiki pages and chat messages, click-to-navigate `[[slug]]` refs, and a backlinks panel showing every page and message that references the current page. See [Wikis](#wikis) below for why this matters.

**Calendars and events with embedded chat** -- Every event carries its own message channel that inherits the full chat pipeline (reactions, threads, attachments, translation). Recurring events via RFC 5545 RRULE, agenda/week/month views, RSVP tracking, and owner-scoping to either a user or a server. Event titles and descriptions translate through the same tone-preserving pipeline as everything else, so a Spanish-language standup invite lands natively in every reader's preferred language.

**Connected surfaces via `[[kind:slug]]` embeds** -- Messages, wiki pages, and events all share a single embed fabric. `[[page-slug]]` renders as a clickable wiki link; `[[msg:slug]]` renders as an inline message preview with author and channel context; `[[event:slug]]` renders as an inline invite card with RSVP buttons you can click without leaving the page you're reading. A weekly standup embedded on a wiki page lets readers join the invite list in one click. A runbook linked from a chat message opens the wiki panel at that section. Each surface's content keeps flowing through the translation pipeline whether it's viewed directly or as an embed.

**End-to-end encrypted DMs** -- Client-side ECDH P-256 key exchange with AES-256-GCM encryption. The server never sees DM plaintext. Translation runs after local decryption.

**Choice of translation backend** -- Four options, grouped into two tiers. **Tone-preserving**: Anthropic Claude, OpenAI GPT, or self-hosted Ollama, each running the same three-stage classify/translate/idiom-check pipeline. **Translation-only**: browser-local Transformers.js with Helsinki-NLP OPUS models for users who want zero external dependencies and will trade tone analysis for full offline operation. See [Translation Pipeline](#translation-pipeline) for details.

**ActivityPub-shaped from day one** -- The data model uses ActivityPub primitives (Actors, Objects, Activities, Collections) even though federation is not yet active. When it activates, it is a flip, not a rewrite.

**Discord-shaped UX** -- Servers, channels, DMs, real-time WebSocket messaging. Three-panel layout with server sidebar, channel list, and chat area.

**Hippocratic License** -- Universal translation is infrastructure for human flourishing, not a commodity to be metered. The [Hippocratic License 3.0](LICENSE.md) structurally excludes surveillance and human-rights-violating deployments.

## Quick Start

```bash
# Clone and install
git clone https://github.com/KohlJary/babelr.git
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

### Backend options

| Backend | Tier | Where it runs | Setup |
|---------|------|---------------|-------|
| **Anthropic Claude** | Tone-preserving | Server proxy → `api.anthropic.com` | Paste your API key once |
| **OpenAI GPT** | Tone-preserving | Server proxy → `api.openai.com` | Paste your API key once |
| **Ollama** (self-hosted) | Tone-preserving | Browser → your Ollama instance directly | Point at `http://localhost:11434` or your internal host |
| **Transformers.js** (local) | Translation-only | Browser-local (WASM) | Nothing — runs out of the box |

The three LLM backends share the same classify-translate-idiom prompt and produce the same structured response shape, so switching providers changes quality and cost but not feature surface. Register, intent, confidence, and idiom glosses all flow through identically.

Ollama is notably the only backend where the Babelr server is **not** in the translation path at all — the browser calls your Ollama instance directly. That's deliberate: the whole point of Ollama support is the enterprise air-gap story where the Babelr server should not be able to see plaintext translations at any point in the pipeline. Cloud providers (Anthropic, OpenAI) route through the server purely so the API key stays out of browser-accessible JavaScript.

Transformers.js is the "no setup, no API key, works offline" option. It uses purpose-built neural translation models (Helsinki-NLP OPUS) rather than an instruction-following LLM, so the output is direct translation without the register/intent/idiom metadata. The UI degrades cleanly — confidence dots and idiom panels simply don't render when the metadata isn't there.

## The `[[kind:slug]]` Embed System

Every piece of content in Babelr — messages, wiki pages, calendar events, files (coming soon), work items (via plugin) — carries a short, copy-paste-friendly slug. Type `[[kind:slug]]` anywhere that accepts text and it renders as a live, interactive embed of the referenced content. This is the connective tissue that makes Babelr feel like one workspace instead of five separate tools.

### Built-in embed kinds

| Syntax | Renders as | Interactive? |
|--------|-----------|-------------|
| `[[page-slug]]` | Clickable wiki link | Opens wiki panel at that page |
| `[[msg:abc1234xyz]]` | Inline message preview with author, channel, and content snippet | Click navigates to the source channel |
| `[[event:abc1234xyz]]` | Inline invite card with date/time, location, and attendee counts | RSVP buttons (Going / Interested / Decline) work directly from the card |

### How it works

The parser (`parseWikiRefs` in `@babelr/shared`) is pure and synchronous — it scans text for `[[...]]` refs, classifies each by prefix, and returns typed ref objects with slug, kind, display text, and character offsets. Refs inside fenced or inline code blocks are ignored so people can write about the syntax without triggering resolution.

On the client, `renderWithEmbeds` splits markdown content on embed refs and interleaves the corresponding React components (`MessageEmbed`, `EventEmbed`, and soon `FileEmbed`, `TaskEmbed`) between the rendered markdown chunks. Each embed component fetches its data independently with a module-level cache that dedupes concurrent requests and keeps every mounted instance of the same slug in sync — change your RSVP on one event embed and every other embed of the same event on the page updates instantly.

Embeds translate. If the referenced content is in a different language, the embed runs through the same translation pipeline as everything else. A Spanish wiki page can embed a Japanese meeting invite and an English chat message, and a French reader sees all three in French.

### Plugin extensibility

The embed system is designed to be extended. The built-in kinds (page, msg, event) are the foundation; the plugin system (in development) allows third parties to register new `[[kind:slug]]` prefixes that render real content from external services inside Babelr:

- `[[jira:PROJ-456]]` → inline Jira ticket with status, assignee, and priority
- `[[gh:owner/repo#123]]` → GitHub PR with file list and review status
- `[[ado:pr-1234]]` → Azure DevOps pull request with diff viewer

Plugins export a React component with the same `{ slug, onNavigate }` contract as the built-in embeds, register their kind prefix in a manifest, and optionally provide server-side routes for data fetching and credential storage. The project management surface is being built as the first plugin — a full-featured kanban board and sprint planner implemented entirely through the plugin API — to validate that the API is expressive enough for real workloads before third parties build on it.

The parser stays pure. All dynamic behavior lives in the component registry above it. An unrecognized prefix falls through to a generic placeholder, so a broken or missing plugin never crashes the page.

## Wikis

Chat platforms are structurally hostile to knowledge. Threads scroll away. Pins get buried. Search finds fragments without context. Every team eventually ends up with "the one person who remembers how X works" and a dread of what happens when they leave. Slack, Discord, and Teams have all had a decade to solve this and none of them have.

Babelr ships a first-class per-server wiki with three properties that make it more than a Notion bolt-on:

**1. Bidirectional links between wiki and chat.** Type `[[page-slug]]` in any message and it renders as a clickable link that opens the wiki panel at that page. Type `[[page-slug]]` inside a wiki page and the same thing happens, navigating in place. Every page has a "Linked from" panel listing every other page and every chat message that references it. Right-click any message and "New wiki page from message" seeds a draft with the message content — you can promote a useful explanation into durable knowledge in two clicks, and the new page will show the source message in its backlinks.

**2. Mixed-language content as a first-class case.** Pages are chunked by paragraph and translated chunk-by-chunk through the same tone-preserving pipeline used for chat. A single page can have a Spanish onboarding note, a French code-style guide, a German review-etiquette section, and a Japanese break-time reminder — each in its author's native language — and every reader sees the whole page in their own. Each paragraph's source language is detected independently, so the author never has to declare anything. Headings translate. Code blocks pass through byte-identical. Idioms from the source language come through with their target-language equivalents attached.

**3. Edit-aware, session-persistent translation cache.** Translations are keyed by content hash, not page id. Edit one paragraph and only that paragraph re-translates on the next open — the rest pull instantly from localStorage. Close the panel, reload the tab, come back tomorrow: the translated page shows up with zero network calls until something actually changes. This is the same cache that messages will migrate onto in a follow-up PR.

Try it yourself: `docs/testing/wiki-mixed-language-fixture.md` contains a drop-in test page covering five languages and a fenced code block. Paste it into a fresh wiki page, open it with `preferredLanguage` set to English, and watch a coherent multilingual team document render in a single language while staying faithful to each section's original voice.

No other chat platform does this. It is not even on their roadmaps.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | TypeScript, Fastify 5, Drizzle ORM |
| Database | PostgreSQL |
| Frontend | React 19, Vite |
| Real-time | WebSocket (@fastify/websocket) |
| Translation (tone-preserving) | Anthropic Claude, OpenAI GPT, or self-hosted Ollama (user's own key / instance) |
| Translation (translation-only) | Transformers.js, Helsinki-NLP OPUS models (browser-local) |
| Encryption | Web Crypto API (ECDH P-256 + AES-256-GCM) |
| Monorepo | npm workspaces |

## Documentation

- [Self-Hosting Guide](docs/SELF_HOST.md) -- Docker and manual deployment
- [Architecture](docs/ARCHITECTURE.md) -- Data model, translation pipeline, E2E crypto
- [Privacy](docs/PRIVACY.md) -- What data is stored, what isn't, and why
- [Federation Testing](docs/FEDERATION_TESTING.md) -- Local two-instance rig and full manual test checklist
- [Contributing](CONTRIBUTING.md) -- How to contribute

## License

Babelr is licensed under the [Hippocratic License 3.0](LICENSE.md) (HL3-FULL).

This means you are free to use, modify, and distribute this software, provided you comply with the ethical standards defined in the license. These include prohibitions on human rights violations, mass surveillance, and environmental destruction.

Universal translation is uniquely dangerous if inverted for surveillance. The license is not an afterthought -- it is a structural commitment.

Copyright (c) 2026 Kohl Jary and contributors
