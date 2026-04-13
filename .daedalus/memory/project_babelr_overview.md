---
name: Babelr Project Overview
description: Core concept, architecture, and build plan for the Babelr federated chat app with tone-preserving translation
type: project
---

Babelr is a federated chat system with a tone-preserving LLM translation layer as its core value prop. Users write in their native language; recipients read in theirs. Translation preserves register, idiom, humor, and intent shape.

**Why:** Universal translation infrastructure for human flourishing, not a commodity. The name references the Tower of Babel — building infrastructure that makes linguistic difference navigable without erasing it.

**How to apply:**
- Every architectural decision should preserve the privacy story (server never touches translated plaintext)
- ActivityPub-shaped data model from day one even though federation is Phase 2
- Tone preservation is THE differentiator — not a v2 feature
- Hippocratic License (HL3) from commit one, non-negotiable
- Stack: TypeScript (Fastify/NestJS) + Postgres backend, React frontend, WebSockets
- Client-side translation via BYO API key (Phase 1), browser-local inference later
- Build order: scaffolding → raw chat → translation MVP → tone pipeline → servers/channels/DMs → E2E → browser-local → polish
- Phase 1 is centralized but production-quality; Phase 2 activates federation; Phase 3 is mobile/voice
