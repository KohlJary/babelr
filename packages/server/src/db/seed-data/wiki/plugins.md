# Plugins

Babelr exposes two extension points — the **embed registry** and the **view registry** — as a plugin SDK. First-party features (wiki, calendar, files, voice CallView) register against the same API plugin authors use, so plugins ship with full parity rather than second-class status.

## What a plugin can do

- **Register new `[[kind:slug]]` embed kinds.** A plugin defines how its kind renders inline in messages, how it renders in the right-sidebar preview, and what "Open in [X]" navigates to.
- **Register new main-panel views.** Full screens that replace the chat surface, with their own sidebar toolbar entry if the plugin provides an icon.
- **Add server routes.** Mounted under `/plugins/<id>/*` — the plugin's namespace.
- **Own database tables.** Schema migrations ship with the plugin; tables get a `plugin_<id>_*` prefix.
- **Federate.** Plugin embed kinds automatically participate in cross-Tower federation through the standard `[[server@tower:kind:slug]]` proxy — plugin authors just provide a `resolveBySlug` handler.

## Shape of a plugin

```ts
import { definePlugin } from '@babelr/plugin-sdk';

export default definePlugin({
  id: 'polls',
  name: 'Polls & Quizzes',
  version: '0.1.0',
  dependencies: { babelr: '^0.1.0' },

  migrations: [
    { id: 1, name: 'init', up: 'CREATE TABLE plugin_polls_polls (...)' },
  ],

  serverRoutes: async (fastify) => {
    fastify.post('/polls', async (req) => { /* ... */ });
    fastify.post('/polls/:id/vote', async (req) => { /* ... */ });
  },

  federationHandlers: {
    poll: {
      resolveBySlug: async (slug, ctx) => {
        // Return the JSON shape renderPreview consumes, or null if the
        // caller can't see it.
        return { /* ... */ };
      },
    },
  },

  setupClient: async (api) => {
    const { createElement } = await import('react');
    api.registerEmbed({
      kind: 'poll',
      label: 'Poll',
      navigateLabel: 'Open poll',
      renderInline: (props) => /* compact card */,
      renderPreview: (props) => /* full poll with vote buttons */,
      navigate: (args, ctx) => { /* ... */ },
    });
  },
});
```

## Trust model

**Plugins are not sandboxed.** Plugin server code runs in your Tower's Node process. Plugin client code runs in your users' browsers. Install only plugins you trust — the same way you treat npm dependencies in any Node project.

This is a deliberate trade-off: **vastly simpler API surface, full capability parity with first-party code**, in exchange for requiring admin review before install. The alternative (WASM sandboxing, vm2 isolation) was considered and rejected for v1 — the ecosystem isn't large enough yet to justify the API constraints sandboxing would force.

## Installing a plugin

Until Phase 5 freezes the manifest and ships npm-based distribution, plugins live in-tree at `packages/plugins/<id>/`. To add a plugin to your Tower:

1. Drop the plugin's directory under `packages/plugins/`
2. Add an import + entry in `packages/server/src/plugins/registered.ts`
3. Add an import + entry in `packages/client/src/plugins/registered.ts`
4. Restart the Tower — migrations run, routes mount, client registrations fire

Reference implementation: `packages/plugins/hello/` — a minimal plugin that registers `[[hello:name]]` to produce "Hello, name!" embeds, demonstrates all four surfaces (server route, federation handler, client embed, migrations), and stays in-tree as a template plugin authors can copy from.

## Near-term first-party plugins

The roadmap has two validating plugins lined up, in order:

1. **Polls & Quizzes** — simple SDK case. Validates schema migrations, real-time sync, translation integration.
2. **Project Management** — complex SDK case. Validates the view-plugin-path (plugin-provided kanban panel), complex federation, and drag-and-drop UI surfaces.

After both ship, the manifest format freezes and npm-based distribution opens up.
