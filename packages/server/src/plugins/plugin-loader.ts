// SPDX-License-Identifier: MIT
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { sql } from 'drizzle-orm';
import type {
  PluginManifest,
  FederationHandler,
  PluginInboxHandler,
  PluginCaller,
} from '@babelr/plugin-sdk';
import { and, eq } from 'drizzle-orm';
import type { WsServerMessage } from '@babelr/shared';
import { PERMISSIONS } from '@babelr/shared';
import { actors } from '../db/schema/actors.ts';
import { collectionItems } from '../db/schema/collections.ts';
import { enqueueToFollowers } from '../federation/delivery.ts';
import { verifySignedRequest } from '../federation/inbox.ts';
import { isActorAllowed } from '../federation/policy.ts';
import { hasPermission } from '../permissions.ts';
import { registeredPlugins } from './registered.ts';
import '../types.ts';

/**
 * Plugin runtime wiring. At Tower boot:
 *   1. Validate each manifest's compatibility with the running Tower
 *      version.
 *   2. Ensure the plugin_migrations tracking table exists.
 *   3. Run any pending migrations per plugin, in order, recording
 *      applied ids so re-starts don't re-apply.
 *   4. Mount each plugin's serverRoutes under /plugins/<id>.
 *   5. Register federation handlers so /embeds/resolve can dispatch to
 *      plugin kinds the same way it does first-party kinds.
 *
 * Plugins ship in-tree under packages/plugins/<id>/ during Phase 1–4;
 * Phase 5 switches to npm packages installed into the Tower, with this
 * loader scanning a plugins directory at runtime. The registered.ts
 * static list is the stand-in until then.
 */

const BABELR_VERSION = '0.1.0';

// kind -> handler, populated from each plugin's federationHandlers and
// queried by routes/embeds.ts when it sees an unknown kind.
const federationHandlers = new Map<string, FederationHandler>();

export function getPluginFederationHandler(kind: string): FederationHandler | undefined {
  return federationHandlers.get(kind);
}

// kind -> id of the plugin that owns it. The by-slug route for a kind
// lives at /plugins/<id>/<kind>/by-slug/:slug, so anything dialing it
// (routes/embeds.ts, for a remote Tower) needs the owning plugin's id,
// which is usually not the kind (polls owns `poll`, project-management
// owns `task` and `board`).
const kindToPluginId = new Map<string, string>();

/** Path of a plugin kind's by-slug route, on this Tower or any other
 *  running the same plugin. Undefined for a kind no plugin owns. */
export function pluginBySlugPath(kind: string, slug: string): string | undefined {
  const id = kindToPluginId.get(kind);
  if (!id) return undefined;
  return `/plugins/${id}/${kind}/by-slug/${encodeURIComponent(slug)}`;
}

// objectType -> handler, populated from each plugin's inboxHandlers.
// Queried by inbox.ts when it receives an AS2 Create/Update/Delete
// whose object type doesn't match any built-in handler.
const inboxHandlers = new Map<string, PluginInboxHandler>();

export function getPluginInboxHandler(objectType: string): PluginInboxHandler | undefined {
  return inboxHandlers.get(objectType);
}

/** Check if an activity's object type (which may be a string or an
 *  array of strings for multi-typed objects) matches any registered
 *  plugin inbox handler. Returns the handler and matched type. */
export function findPluginInboxHandler(
  objectType: string | string[],
): { handler: PluginInboxHandler; matchedType: string } | undefined {
  const types = Array.isArray(objectType) ? objectType : [objectType];
  for (const t of types) {
    const handler = inboxHandlers.get(t);
    if (handler) return { handler, matchedType: t };
  }
  return undefined;
}

/** Return all registered plugin inbox handlers. Used by handleDelete
 *  where the activity carries only the object URI (no type). Each
 *  handler decides if the URI belongs to it. */
export function allPluginInboxHandlers(): PluginInboxHandler[] {
  return Array.from(inboxHandlers.values());
}

async function ensureMigrationsTable(fastify: FastifyInstance): Promise<void> {
  await fastify.db.execute(sql`
    CREATE TABLE IF NOT EXISTS plugin_migrations (
      plugin_id TEXT NOT NULL,
      migration_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (plugin_id, migration_id)
    )
  `);
}

async function appliedMigrationIds(
  fastify: FastifyInstance,
  pluginId: string,
): Promise<Set<number>> {
  const res = await fastify.db.execute(
    sql`SELECT migration_id FROM plugin_migrations WHERE plugin_id = ${pluginId}`,
  );
  const rows = (res as unknown as Array<{ migration_id: number }>) ?? [];
  return new Set(rows.map((r) => r.migration_id));
}

async function runPluginMigrations(
  fastify: FastifyInstance,
  manifest: PluginManifest,
): Promise<void> {
  if (!manifest.migrations || manifest.migrations.length === 0) return;
  const applied = await appliedMigrationIds(fastify, manifest.id);
  const sorted = [...manifest.migrations].sort((a, b) => a.id - b.id);
  for (const m of sorted) {
    if (applied.has(m.id)) continue;
    fastify.log.info(
      { plugin: manifest.id, migration: m.id, name: m.name },
      'applying plugin migration',
    );
    if (typeof m.up === 'string') {
      // Split on semicolons at end-of-line so multi-statement migrations
      // run as separate queries (postgres-js's extended-query mode can't
      // handle multi-statement bodies in a single .execute call).
      const statements = m.up
        .split(/;\s*(?:\n|$)/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      for (const stmt of statements) {
        await fastify.db.execute(sql.raw(stmt));
      }
    } else {
      await m.up(async (q) => {
        // Functional form is a safety valve for plugins that need
        // procedural migrations; most plugins pass a SQL string.
        const r = await fastify.db.execute(sql.raw(q));
        const rows = (r as unknown as unknown[]) ?? [];
        return { rows };
      });
    }
    await fastify.db.execute(
      sql`INSERT INTO plugin_migrations (plugin_id, migration_id, name) VALUES (${manifest.id}, ${m.id}, ${m.name})`,
    );
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Followers collection URI of a server (Group actor), or null when
 *  the id is malformed or isn't a server. Membership in a server is a
 *  row in that collection, for local and remote members alike. */
async function serverFollowersUri(fastify: FastifyInstance, serverId: string) {
  if (typeof serverId !== 'string' || !UUID_RE.test(serverId)) return null;
  const [server] = await fastify.db
    .select({ followersUri: actors.followersUri })
    .from(actors)
    .where(and(eq(actors.id, serverId), eq(actors.type, 'Group')))
    .limit(1);
  return server?.followersUri ?? null;
}

async function isServerMember(
  fastify: FastifyInstance,
  actor: { uri: string },
  serverId: string,
): Promise<boolean> {
  if (!actor?.uri) return false;
  const followersUri = await serverFollowersUri(fastify, serverId);
  if (!followersUri) return false;
  const [row] = await fastify.db
    .select({ id: collectionItems.id })
    .from(collectionItems)
    .where(
      and(eq(collectionItems.collectionUri, followersUri), eq(collectionItems.itemUri, actor.uri)),
    )
    .limit(1);
  return !!row;
}

async function broadcastToServerMembers(
  fastify: FastifyInstance,
  serverId: string,
  message: WsServerMessage,
): Promise<void> {
  const followersUri = await serverFollowersUri(fastify, serverId);
  if (!followersUri) return;
  const members = await fastify.db
    .select({ id: actors.id })
    .from(collectionItems)
    .innerJoin(actors, eq(actors.uri, collectionItems.itemUri))
    .where(and(eq(collectionItems.collectionUri, followersUri), eq(actors.local, true)));
  for (const m of members) fastify.broadcastToActor(m.id, message);
}

/** Install the access helpers plugins reach through the SDK. */
function decorateAccess(fastify: FastifyInstance): void {
  if (!fastify.hasDecorator('pluginAccess')) {
    fastify.decorate('pluginAccess', {
      isMember: (actor: { uri: string }, serverId: string) =>
        isServerMember(fastify, actor, serverId),
      isServerAdmin: async (actor: { id: string }, serverId: string) => {
        if (!actor?.id || typeof serverId !== 'string' || !UUID_RE.test(serverId)) return false;
        return hasPermission(fastify.db, serverId, actor.id, PERMISSIONS.MANAGE_SERVER);
      },
    });
  }
  if (!fastify.hasDecorator('broadcastToServerMembers')) {
    fastify.decorate('broadcastToServerMembers', (serverId: string, message: WsServerMessage) =>
      broadcastToServerMembers(fastify, serverId, message),
    );
  }
}

/**
 * Who is calling a by-slug route: the local session actor, or a
 * federated actor whose HTTP Signature verifies (and whose domain the
 * federation policy allows). Null for anyone else.
 */
async function resolveBySlugCaller(
  fastify: FastifyInstance,
  request: FastifyRequest,
): Promise<PluginCaller | null> {
  const a = request.actor;
  if (a && a.local === true) return { id: a.id, uri: a.uri, local: true };
  if (!request.headers.signature) return null;
  // verifySignedRequest requires the signature to cover
  // (request-target), host, date and digest, the Date to be within 5
  // minutes, and the Digest to match the (empty) body, so a captured
  // by-slug request can be replayed for 5 minutes at most.
  let remote;
  try {
    remote = await verifySignedRequest(fastify, {
      headers: request.headers,
      method: request.method,
      url: request.url,
    });
  } catch {
    return null;
  }
  if (!remote) return null;
  if (!remote.local && !isActorAllowed(fastify.config, remote.uri)) return null;
  return { id: remote.id, uri: remote.uri, local: remote.local };
}

/** Normalize a manifest publicRoutes entry to 'METHOD /path'. */
function routeKey(method: string, path: string): string {
  const p = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return `${method.toUpperCase()} ${p || '/'}`;
}

function parsePublicRoutes(manifest: PluginManifest): Set<string> {
  const out = new Set<string>();
  for (const entry of manifest.publicRoutes ?? []) {
    const m = /^\s*([A-Za-z]+)\s+(\/\S*)\s*$/.exec(entry);
    if (!m)
      throw new Error(`plugin ${manifest.id}: bad publicRoutes entry ${JSON.stringify(entry)}`);
    out.add(routeKey(m[1], m[2]));
    if (m[1].toUpperCase() === 'GET') out.add(routeKey('HEAD', m[2]));
  }
  return out;
}

function isCompatible(range: string, version: string): boolean {
  // Minimal semver check: accept '^X.Y.Z' matching major version, or
  // the literal version. A full semver implementation is Phase 5 work;
  // for in-tree plugins in Phase 1 the versions match by construction.
  if (range === version) return true;
  const caretMatch = /^\^(\d+)\./.exec(range);
  if (caretMatch) {
    const wantedMajor = caretMatch[1];
    const actualMajor = version.split('.')[0];
    return wantedMajor === actualMajor;
  }
  return false;
}

async function pluginLoader(fastify: FastifyInstance): Promise<void> {
  if (registeredPlugins.length === 0) {
    fastify.log.info('plugin loader: no plugins registered');
    return;
  }
  await ensureMigrationsTable(fastify);
  decorateAccess(fastify);

  for (const manifest of registeredPlugins) {
    if (!isCompatible(manifest.dependencies.babelr, BABELR_VERSION)) {
      fastify.log.warn(
        {
          plugin: manifest.id,
          requires: manifest.dependencies.babelr,
          running: BABELR_VERSION,
        },
        'plugin skipped — incompatible Babelr version',
      );
      continue;
    }

    try {
      await runPluginMigrations(fastify, manifest);
    } catch (err) {
      fastify.log.error(
        { err: String(err), plugin: manifest.id },
        'plugin migration failed — skipping plugin',
      );
      // Also log to console in dev so the message is visible even if
      // the structured logger is quieter than expected.
      console.error(`[plugin:${manifest.id}] migration error:`, err);
      continue;
    }

    // Expose a federation delivery helper so plugin serverRoutes can
    // push AS2 activities to Group followers without importing server
    // internals (which breaks the client build when it traces into the
    // manifest).
    if (!fastify.hasDecorator('deliverToGroupFollowers')) {
      fastify.decorate(
        'deliverToGroupFollowers',
        async (groupId: string, activity: Record<string, unknown>) => {
          const [group] = await fastify.db
            .select()
            .from(actors)
            .where(eq(actors.id, groupId))
            .limit(1);
          if (!group || !group.local) return;
          await enqueueToFollowers(fastify, group, activity);
        },
      );
    }

    let publicRoutes: Set<string>;
    try {
      publicRoutes = parsePublicRoutes(manifest);
    } catch (err) {
      fastify.log.error({ err: String(err), plugin: manifest.id }, 'plugin skipped');
      continue;
    }
    const prefix = `/plugins/${manifest.id}`;
    const kinds = Object.keys(manifest.federationHandlers ?? {});
    const bySlugRoutes = new Set(kinds.map((k) => routeKey('GET', `/${k}/by-slug/:slug`)));

    await fastify.register(
      async (scoped) => {
        // Deny by default. Every route this plugin mounts needs a local
        // session unless the manifest lists it in publicRoutes. The
        // auto-mounted by-slug routes do their own check below, since
        // they also admit verified federated callers. Registered before
        // serverRoutes so it runs ahead of any hook the plugin adds.
        scoped.addHook('onRequest', async (request, reply) => {
          const url = request.routeOptions.url;
          // No matched route: let the 404 through rather than reveal
          // which paths exist by answering 401 to some of them.
          if (!url) return;
          const rel = url.startsWith(prefix) ? url.slice(prefix.length) || '/' : url;
          const key = routeKey(request.method, rel);
          const getKey = routeKey(request.method === 'HEAD' ? 'GET' : request.method, rel);
          if (publicRoutes.has(key)) return;
          if (bySlugRoutes.has(getKey)) return;
          if (!request.actor || request.actor.local !== true) {
            return reply.status(401).send({ error: 'Not authenticated' });
          }
        });

        // Auto-mount a /by-slug/:slug route per federation-handled kind
        // so the cross-Tower /embeds/resolve proxy has something to dial.
        // Plugin authors only provide resolveBySlug; the transport and
        // caller authentication are handled here. The handler gets the
        // caller and decides what that caller may see.
        if (manifest.federationHandlers) {
          const handlers = manifest.federationHandlers;
          for (const kind of kinds) {
            const handler = handlers[kind];
            scoped.get<{ Params: { slug: string } }>(
              `/${kind}/by-slug/:slug`,
              async (request, reply) => {
                const caller = await resolveBySlugCaller(fastify, request);
                if (!caller) return reply.status(401).send({ error: 'Not authenticated' });
                const { slug } = request.params;
                const result = await handler.resolveBySlug(slug, {
                  callerUri: caller.uri,
                  caller,
                  fastify,
                });
                if (!result) return reply.status(404).send({ error: 'Not found' });
                return result;
              },
            );
          }
        }
        if (manifest.serverRoutes) {
          await manifest.serverRoutes(scoped);
        }
      },
      { prefix },
    );

    if (manifest.federationHandlers) {
      for (const kind of kinds) {
        federationHandlers.set(kind, manifest.federationHandlers[kind]);
        kindToPluginId.set(kind, manifest.id);
      }
    }

    if (manifest.inboxHandlers) {
      for (const objectType of Object.keys(manifest.inboxHandlers)) {
        inboxHandlers.set(objectType, manifest.inboxHandlers[objectType]);
      }
    }

    fastify.log.info({ plugin: manifest.id, version: manifest.version }, 'plugin loaded');
  }
}

export default fp(pluginLoader, {
  name: 'plugin-loader',
  dependencies: ['db'],
});
