---
name: Build project management as plugin reference implementation
description: User wants to implement project-management as the first plugin using the embed-plugin-system, proving the plugin API by building a real feature through it
type: feedback
originSessionId: 173c999b-e4bd-4c2c-b113-6b1a648ba383
---
Build the project management surface as a plugin (using the embed-plugin-system architecture) rather than as hardcoded first-party code. This serves double duty: PM ships as a real feature AND the plugin system gets validated by a non-trivial reference implementation.

**Why:** Kohl's insight — if the first plugin is a full-featured PM tool built through the same API that third parties would use, it proves the plugin API is expressive enough for real workloads. If it's too painful, the API needs work before opening it to others.

**How to apply:** When scoping embed-plugin-system and project-management, design them as one project: plugin system first (manifest, registry, client component contract, server route prefix, credential storage), then PM as `packages/plugins/project-management/` built entirely through the plugin API. If something requires reaching outside the plugin boundary, that's a signal the API is missing a capability.
