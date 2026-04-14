# Babelr

**A federated workspace where knowledge actually persists.**

Chat platforms are structurally hostile to knowledge. Threads scroll away. Pins get buried. Search finds fragments without context. Every long-lived community ends up with "the one person who remembers how X works" and a quiet dread of what happens when they leave. Slack, Discord, Teams, and Matrix have had a decade to solve this and none of them have — the standard escape hatch is to bolt on Notion or Confluence, which is to say, to admit chat can't hold knowledge and hand the problem to a separate tool.

Babelr's thesis is that the missing primitive is a **unified embed fabric**: messages, wiki pages, calendar events, files, and (soon) plugin-provided surfaces all reference each other through a single `[[kind:slug]]` syntax. A wiki page can cite the chat message where a decision was made. A calendar event can link to the runbook it's briefing. A chat thread can invite readers directly into an event's RSVP list with one click. Right-click a useful explanation in chat, "New wiki page from message" — durable knowledge in two clicks, and the new page shows the source message in its backlinks. The surfaces stop feeling like separate tools and start behaving like one connected space.

On top of that fabric, a **tone-preserving LLM translation layer** runs across every surface. Users write in their native language and recipients read in theirs — and "translate" means register-aware, idiom-flagging, intent-classifying translation, not the lossy word-for-word substitution that breaks jokes and sarcasm. The runbook you wrote in English and the meeting invite your colleague wrote in Japanese both land in each reader's preferred language with their voice intact. The translation pipeline knows about embeds — `[[kind:slug]]` references survive translation untouched, so cross-language workspaces don't fragment their knowledge graph at the language boundary.

Federation is ActivityPub-shaped from day one. A partner company on their own **Tower** can follow a channel, read a wiki page, RSVP to a calendar event, or join a voice channel without leaving home. Voice / video / screen-share run through an embedded mediasoup SFU — single-container self-host, no separate infrastructure — and federate cleanly via signed JWT handshake.

A Babelr deployment is called a **Tower** — each organization runs their own, and Towers federate with each other. "Server" is reserved for the communities within a Tower (like Discord servers — groups with channels, wikis, calendars, files, and voice rooms). Your company's Tower at `chat.example.com` can federate with your partner's Tower at `collab.partner.org`, and every piece of content that crosses between them translates automatically.

The name is a statement. The Tower of Babel story is usually read as punishment for human hubris, but structurally it is a story about power fragmenting a communication layer that threatened incumbents. Babelr is infrastructure that makes linguistic difference navigable without erasing it — and each Tower is a node in that infrastructure.

Structurally closer to Pentecost than to Esperanto: everyone hearing in their own native tongue.

## Features

**`[[kind:slug]]` embed fabric** -- One unified addressing scheme across every surface: messages, wiki pages, calendar events, files, images, and (via plugins) anything else. `[[wiki:design-doc]]` renders as a clickable wiki link; `[[msg:abc1234xyz]]` renders as an inline message preview with author and channel context; `[[event:weekly-sync]]` renders as an invite card with RSVP buttons you click without leaving the page; `[[file:onboarding-deck]]` renders as a file card with download. Click any embed and the full content opens in a right sidebar — close it or "Open in [X]" to navigate to the source. A weekly standup embedded on a wiki page lets readers join the invite list in one click. A runbook linked from a chat message opens the wiki at that section. Each embed translates through the same pipeline as everything else, and the syntax federates cross-Tower (`[[partner@partner.org:wiki:onboarding]]`).

**Server wikis with mixed-language translation** -- Long-form knowledge that persists outside the chat stream, and the first wiki system in any chat platform where a single page can be authored in five languages and read natively in any sixth. Bidirectional links between wiki pages and chat messages — every page has a "Linked from" panel listing every other page and every chat message that references it. Right-click any message → "New wiki page from message" promotes ephemeral chat into durable knowledge in two clicks. See [Wikis](#wikis) below for why this matters.

**Voice / video / screen-share** -- Voice channels via mediasoup SFU embedded in the server process — single-container self-host, no separate media service to operate. Webcam and screen-share work as direct extensions of the same flow. Federated: a user on one Tower can join a voice channel on another Tower via signed JWT handshake (browser ↔ origin SFU directly; the home Tower only proxies the auth handshake). When you're in a call and viewing the voice channel, the right sidebar shows the channel's text chat alongside the participant grid.

**Calendars and events with embedded chat** -- Every event carries its own message channel that inherits the full chat pipeline (reactions, threads, attachments, translation). Recurring events via RFC 5545 RRULE, agenda/week/month views, RSVP tracking, and owner-scoping to either a user or a server. Event titles and descriptions translate through the same tone-preserving pipeline as everything else.

**Tone-preserving translation** -- Not "translate X to French" but "translate X to French preserving the casual-affectionate register and the self-deprecating joke structure." Every translation carries a metadata envelope: detected register, intent classification, confidence score, and flagged idioms with hover-gloss explanations. Embeds survive translation untouched — `[[wiki:design-doc]]` stays `[[wiki:design-doc]]` so cross-language workspaces don't fragment their knowledge graph at the language boundary.

**Choice of translation backend** -- Four options, grouped into two tiers. **Tone-preserving**: Anthropic Claude, OpenAI GPT, or self-hosted Ollama, each running the same three-stage classify/translate/idiom-check pipeline. **Translation-only**: browser-local Transformers.js with Helsinki-NLP OPUS models for users who want zero external dependencies and will trade tone analysis for full offline operation. See [Translation Pipeline](#translation-pipeline) for details.

**ActivityPub federation** -- Towers federate via ActivityPub. Friends, DMs, server membership, channel messages, reactions, wiki pages, calendar events, files, voice channels, profile updates, and server metadata all cross Tower boundaries with HTTP-signed delivery and automatic retry. Deploy your own Tower and federate with partners — or run closed with zero external access.

**Plugin-extensible** -- Both the embed system and the main-panel view system are built around explicit registries (`registerEmbed`, `registerView`). First-party kinds and views (wiki, calendar, files, voice CallView) register against the same API plugin authors will use, so plugins ship with parity rather than second-class status. The embed-plugin-system manifest format and lazy loading is the next item on the roadmap.

**End-to-end encrypted DMs** -- Client-side ECDH P-256 key exchange with AES-256-GCM encryption. The server never sees DM plaintext. Translation runs after local decryption.

**Discord-shaped UX** -- Servers, channels, DMs, real-time WebSocket messaging. Three-panel layout with server sidebar, channel list, and chat area.

**Hippocratic License** -- Universal translation and federated workspaces are infrastructure for human flourishing, not commodities to be metered. The [Hippocratic License 3.0](LICENSE.md) structurally excludes surveillance and human-rights-violating deployments.

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

Every piece of content in Babelr — messages, wiki pages, calendar events, files, images — carries a short, copy-paste-friendly slug. Type `[[kind:slug]]` anywhere that accepts text and it renders as a live, interactive embed of the referenced content. This is the connective tissue that makes Babelr feel like one workspace instead of five separate tools.

### Built-in embed kinds

| Syntax | Renders as | Click behavior |
|--------|-----------|----------------|
| `[[page-slug]]` or `[[wiki:page-slug]]` | Clickable wiki link | Opens page preview in right sidebar; "Open in Wiki" navigates to the full panel |
| `[[msg:abc1234xyz]]` | Inline message preview with author, channel, and content snippet | Sidebar preview with full message + context; "Go to message" jumps to source |
| `[[event:weekly-sync]]` | Inline invite card with date/time, location, and attendee counts | Sidebar preview with description + RSVP; "Open in Calendar" navigates |
| `[[file:onboarding-deck]]` | File card with type icon, name, size | Sidebar preview with metadata + download |
| `[[img:diagram]]` | Inline image | Large image preview in sidebar |
| `[[man:wiki-syntax]]` | Manual link | Sidebar preview of the manual page |
| `[[partner@partner.org:wiki:onboarding]]` | Cross-Tower embed (federation proxy) | Same shape as local; fetched via signed GET |

### How it works

The parser (`parseWikiRefs` in `@babelr/shared`) is pure and synchronous — it scans text for `[[...]]` refs, classifies each by prefix, and returns typed ref objects with slug, kind, display text, and character offsets. Refs inside fenced or inline code blocks are ignored so people can write about the syntax without triggering resolution.

On the client, every kind is registered in an `EmbedRegistry` with three things: a `renderInline` (the in-message card), a `renderPreview` (the right-sidebar full view), and a `navigate` (what "Open in [X]" does). The renderer dispatches by kind; nothing is hardcoded. Each embed component fetches its data independently with a module-level cache that dedupes concurrent requests and keeps every mounted instance of the same slug in sync — change your RSVP on one event embed and every other embed of the same event on the page updates instantly.

**Embeds translate.** If the referenced content is in a different language, the embed runs through the same translation pipeline as everything else. The translation layer knows about embed syntax — `[[kind:slug]]` references survive translation untouched (placeholder masking for instruction-tuned LLMs, split-translate-rejoin for NMT models), so a Spanish wiki page can embed a Japanese meeting invite and an English chat message, and a French reader sees all three in French without the slug graph fragmenting.

### Plugin extensibility

The embed system is built around two registries with the same shape: `EmbedRegistry` for `[[kind:slug]]` content and `ViewRegistry` for main-panel views. First-party kinds (page, msg, event, file, img, manual) and first-party views (calendar, wiki, files, manual) register against the same API a plugin will use:

```ts
registerEmbed({
  kind: 'jira',
  label: 'Jira ticket',
  navigateLabel: 'Open in Jira',
  renderInline: (props) => <JiraInline ... />,
  renderPreview: (props) => <JiraPreview ... />,
  navigate: (args, ctx) => window.open(`https://jira.example.com/browse/${args.slug}`),
});
```

Once the manifest format and lazy loading land, plugins ship like:

- `[[jira:PROJ-456]]` → inline Jira ticket with status, assignee, and priority
- `[[gh:owner/repo#123]]` → GitHub PR with file list and review status
- `[[poll:retro-vote]]` → inline poll with click-to-vote
- `[[task:board-2-card-15]]` → kanban card with drag-and-drop status

The project management surface and the polls/quizzes plugin are queued as the validating first plugins — built entirely through the plugin API to prove the contract is expressive enough for real workloads before third parties build on it.

The parser stays pure. All dynamic behavior lives in the registries above it. An unrecognized prefix falls through to a generic placeholder, so a broken or missing plugin never crashes the page.

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
