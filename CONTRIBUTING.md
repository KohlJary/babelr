# Contributing to Babelr

Babelr is licensed under the [Hippocratic License 3.0](LICENSE.md). By contributing, you agree that your contributions will be licensed under the same terms.

## Development Setup

**Prerequisites:** Node.js 24+, PostgreSQL 17+, npm 11+

```bash
# Clone and install
git clone https://github.com/YOUR_USERNAME/babelr.git
cd babelr
npm install

# Configure environment
cp .env.example .env
# Edit .env with your database credentials and a session secret

# Set up the database
createdb babelr
npm run db:migrate

# Start development (two terminals)
npm run dev:server   # Fastify on :3000
npm run dev:client   # Vite on :5173
```

## Project Structure

```
babelr/
  packages/
    shared/    TypeScript types shared between server and client
    server/    Fastify backend, Drizzle ORM, WebSocket, translation proxy
    client/    React frontend, translation providers, E2E crypto
```

The monorepo uses npm workspaces. The shared package must be built before the server or client can import from it: `npm run build -w packages/shared`.

## Code Style

- **TypeScript strict mode** throughout
- **ESLint** (flat config) + **Prettier** (single quotes, trailing commas)
- **SPDX license headers** on every source file: `// SPDX-License-Identifier: Hippocratic-3.0`
- Run `npm run lint` and `npm run format:check` before submitting

## Git Workflow

- Create a feature branch: `feat/`, `fix/`, `refactor/`, `chore/`
- Write clear commit messages focused on "why" not "what"
- One logical change per commit
- Open a PR against `main` for review

## Testing

```bash
npm run typecheck          # TypeScript compilation check
npm run lint               # ESLint
npm run format:check       # Prettier

# Translation benchmark (requires ANTHROPIC_API_KEY in .env)
npm run benchmark -w packages/server -- --list
npm run benchmark -w packages/server -- -m sonnet -t es
```

## Database Changes

If you modify the Drizzle schema files in `packages/server/src/db/schema/`:

```bash
npm run db:generate    # Generate migration SQL
npm run db:migrate     # Apply migrations
```

Review generated SQL in `packages/server/src/db/migrations/` before committing.

## Architecture Notes

- **Server never stores translated content.** Translation is client-side only.
- **DM content is E2E encrypted.** The server stores ciphertext.
- **ActivityPub-shaped data model.** Servers are Group actors, channels are OrderedCollections, messages are Notes. Don't fight the AP semantics.
- **Translation pipeline is prompt-driven.** The three-stage prompt (classify, translate, idiom-check) lives in `packages/server/src/benchmark/prompt.ts`.

## Areas for Contribution

- Additional OPUS model language pairs in `packages/client/src/translation/opus-models.ts`
- Mobile-responsive CSS improvements
- Accessibility (ARIA labels, keyboard navigation)
- Test coverage (no test framework set up yet -- a great first contribution)
- Federation (Phase 2) -- connecting Babelr instances via ActivityPub
