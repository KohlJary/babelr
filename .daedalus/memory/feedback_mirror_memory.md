---
name: Mirror memory files into .daedalus/memory
description: Keep .claude memory and .daedalus/memory in sync so project context is portable and available to contributors
type: feedback
originSessionId: 173c999b-e4bd-4c2c-b113-6b1a648ba383
---
All memory files must be mirrored from `.claude/projects/.../memory/` into `.daedalus/memory/` in the repo. This ensures:

1. **Portability** — moving to a new machine doesn't lose project context
2. **Contributor access** — other developers working with their own coding agents get the same architectural context, terminology decisions, and development guidelines
3. **Version control** — memory evolves with the codebase and is reviewable in PRs

**How to apply:** When creating or updating any memory file, write it to BOTH locations. When committing, include `.daedalus/memory/` changes alongside the code changes they relate to. The `.daedalus/memory/MEMORY.md` index should match the `.claude` one.
