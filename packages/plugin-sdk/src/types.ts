// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import type { WikiRefKind } from '@babelr/shared';

/**
 * Plugin manifest — the contract a plugin exports so the Babelr runtime
 * knows what to load, register, and migrate.
 *
 * The manifest is the same on server and client. Each runtime pulls the
 * pieces it needs: the server calls `serverRoutes` and runs `migrations`;
 * the client runs `setupClient` to register embeds and views. Helper
 * fields like `id` / `name` / `version` are read by both.
 *
 * Plugins live in-tree at `packages/plugins/<id>/` during the validation
 * cycle (polls + project-management). npm-based distribution ships later
 * once the manifest format is frozen.
 */

export interface PluginManifest {
  /** Slug-style identifier. Used as the route prefix (/plugins/<id>/*),
   *  the table-name prefix (plugin_<id>_*), and the federation handler
   *  lookup key. Must match /^[a-z][a-z0-9-]*$/. */
  id: string;
  /** Human-readable display name for admin UI. */
  name: string;
  /** Semver. Changes here feed compatibility checks during distribution. */
  version: string;
  /** Optional longer description shown in admin UI. */
  description?: string;
  /** The Babelr versions this plugin is compatible with (semver range).
   *  The loader refuses to load a plugin whose range doesn't intersect
   *  the running Tower's version. */
  dependencies: {
    babelr: string;
  };

  /**
   * Server-side Fastify plugin. Called at Tower boot with a Fastify
   * instance already scoped to `/plugins/<id>` — register routes inside
   * without worrying about the prefix. Use `fastify.db` to read/write
   * your own tables (already namespaced via migrations).
   */
  serverRoutes?: (fastify: FastifyInstance) => Promise<void> | void;

  /**
   * Schema migrations to run at Tower boot. Each migration gets a
   * namespaced transaction; table/index names should be prefixed
   * `plugin_<id>_` by convention. Migrations are applied in order and
   * tracked in plugin_migrations so they only run once.
   */
  migrations?: PluginMigration[];

  /**
   * Federation handlers. For each embed kind the plugin defines, a
   * `resolveBySlug(slug, ctx)` function returns the JSON shape the
   * embed's renderInline / renderPreview expects. Wired into
   * /embeds/resolve for cross-Tower fetches and /plugins/<id>/by-slug/
   * for same-Tower API consumers.
   */
  federationHandlers?: Record<string, FederationHandler>;

  /**
   * Client-side setup. Runs in the browser at app boot. Typically calls
   * registerEmbed() for each `[[kind:slug]]` the plugin contributes and
   * registerView() for each main-panel surface. Imperative on purpose:
   * matches the registry shape first-party kinds already use.
   *
   * The client-only parts of a plugin (React components, DOM logic)
   * must NOT be imported at the manifest's top level — the manifest is
   * loaded on the server too, where React isn't available. Use dynamic
   * imports inside setupClient instead.
   */
  setupClient?: (api: PluginClientApi) => Promise<void> | void;
}

export interface PluginMigration {
  /** Monotonically-increasing index within this plugin's migration set.
   *  Same contract as Drizzle Kit migrations but scoped per-plugin. */
  id: number;
  /** Short description for logs. */
  name: string;
  /** SQL to run, or a function taking a Postgres client if you need
   *  procedural logic. */
  up: string | ((sql: PluginSqlExecutor) => Promise<void>);
}

/**
 * Minimal SQL executor surface exposed to migrations. Kept generic so
 * the underlying driver (postgres.js today, something else tomorrow)
 * isn't baked into the plugin API.
 */
export type PluginSqlExecutor = (
  query: string,
  params?: unknown[],
) => Promise<{ rows: unknown[] }>;

export interface FederationHandler {
  /** Given a slug (and optionally the requesting actor's URI), return
   *  the JSON shape the embed's renderPreview consumes. Return null if
   *  the item doesn't exist or the caller lacks permission — the
   *  caller gets a "locked" embed state. */
  resolveBySlug: (
    slug: string,
    ctx: FederationHandlerContext,
  ) => Promise<unknown | null>;
}

export interface FederationHandlerContext {
  /** ActivityPub URI of the remote actor making the request, if any.
   *  Used for permission checks (is this actor a member of the Group
   *  whose board they're trying to embed?). */
  callerUri?: string;
  /** Fastify instance, so the handler can query the DB or call other
   *  internal helpers. */
  fastify: FastifyInstance;
}

/**
 * Surface handed to setupClient(). Mirrors the registries first-party
 * code already uses, so plugin authors write the same shape of
 * registration code as the built-in polls/wiki/calendar kinds will use
 * after the rewrite. The actual types come from the client's embed and
 * view registries — they're re-exported here for plugin authors.
 */
export interface ClientEmbedDefinition {
  kind: WikiRefKind | string;
  label: string;
  navigateLabel: string;
  /** React component function for the inline embed. SDK keeps the prop
   *  type loose (`unknown`) so plugins don't need to hard-depend on
   *  React's types; plugin authors import the stricter types from the
   *  client's public surface if they want full IntelliSense. */
  renderInline: (props: unknown) => unknown;
  /** React component function for the sidebar preview. */
  renderPreview: (props: unknown) => unknown;
  navigate: (args: { slug: string; serverSlug?: string }, ctx: unknown) => void;
}

export interface ClientViewDefinition {
  id: string;
  label: string;
  icon?: unknown;
  isAvailable?: (host: unknown) => boolean;
  /** React component function for the view. Receives
   *  `{ host, viewState }` — the host's context bag plus the free-form
   *  per-view state the host persists. Plugin authors write normal
   *  function components; SDK mounts via createElement so hooks track
   *  against the component instance. */
  render: (props: { host: unknown; viewState: Record<string, unknown> }) => unknown;
}

export interface ClientSidebarSlotDefinition {
  id: string;
  /** React component. SDK keeps the prop type loose so plugin authors
   *  can import the stricter SidebarSlotHostContext from the client
   *  package if they want full IntelliSense. */
  Component: (props: { host: unknown }) => unknown;
  isAvailable?: (host: unknown) => boolean;
}

export interface PluginClientApi {
  registerEmbed: (def: ClientEmbedDefinition) => void;
  registerView: (def: ClientViewDefinition) => void;
  /** Mount an arbitrary React component in the left sidebar's plugin
   *  slot area. The component owns its own state, buttons, modals,
   *  event wiring — the host just renders it. */
  registerSidebarSlot: (def: ClientSidebarSlotDefinition) => void;
  /** Base URL for this plugin's server-side routes — e.g.
   *  `/plugins/polls`. Plugin fetches should prepend it so they hit the
   *  right namespace regardless of where Babelr is mounted. */
  routeBase: string;
}

