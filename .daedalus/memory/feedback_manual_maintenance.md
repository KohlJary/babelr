---
name: Keep the Babelr Manual up to date
description: When adding new features, update the seed wiki manual pages and ensure the seeder applies updates on Tower upgrades
type: feedback
originSessionId: 173c999b-e4bd-4c2c-b113-6b1a648ba383
---
The built-in Babelr Manual (packages/server/src/db/seed-data/wiki/) must stay current with new features. Two responsibilities:

1. **When adding a new feature**, update or add manual pages to document it. The manual is the first thing a new user sees in their Tower's wiki — stale docs are worse than no docs.

2. **The wiki-seed plugin must apply updates on upgrade**, not just on first boot. Currently it's a no-op if manual pages already exist. Need to change the seeder to compare manifest version/hash against the existing pages and update content for pages whose source files have changed, while preserving any user edits (add a `seeded` flag or version number so the seeder only overwrites pages it originally created and that haven't been user-modified).

**How to apply:** After shipping a feature, check if any manual page needs updating. The relevant files are in `packages/server/src/db/seed-data/wiki/` with a `manifest.json` describing the page tree. Add new pages to the manifest, update existing markdown files, and the seeder handles the rest on the next Tower boot.
