// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { PluginManifest, FederationHandler } from '@babelr/plugin-sdk';
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

export function getPluginFederationHandler(
  kind: string,
): FederationHandler | undefined {
  return federationHandlers.get(kind);
}

async function ensureMigrationsTable(fastify: FastifyInstance): Promise<void> {
  await fastify.db.execute(`
    CREATE TABLE IF NOT EXISTS plugin_migrations (
      plugin_id TEXT NOT NULL,
      migration_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (plugin_id, migration_id)
    )
  ` as unknown as string);
}

async function appliedMigrationIds(
  fastify: FastifyInstance,
  pluginId: string,
): Promise<Set<number>> {
  // Plugin ids are validated against /^[a-z][a-z0-9-]*$/ at registration,
  // so the escaped string inlined below cannot contain SQL meta-chars.
  const res = await fastify.db.execute(
    `SELECT migration_id FROM plugin_migrations WHERE plugin_id = ${escapeSql(pluginId)}` as unknown as string,
  );
  const rows = (res as unknown as { rows?: { migration_id: number }[] }).rows ?? [];
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
      await fastify.db.execute(m.up as unknown as string);
    } else {
      await m.up(async (q, _params) => {
        // Minimal shim — real plugins are expected to use string SQL
        // or call fastify.db themselves via a fastify-plugin. The
        // functional form is a safety valve, not the primary path.
        const r = await fastify.db.execute(q as unknown as string);
        const rows = (r as unknown as { rows?: unknown[] }).rows ?? [];
        return { rows };
      });
    }
    await fastify.db.execute(
      `INSERT INTO plugin_migrations (plugin_id, migration_id, name) VALUES (${escapeSql(manifest.id)}, ${m.id}, ${escapeSql(m.name)})` as unknown as string,
    );
  }
}

// Phase 1 keeps migration bookkeeping simple — all string interpolation
// happens only on manifest-controlled values (id, name, integer id),
// not on user input. Stricter parameterized execute would need direct
// driver access that drizzle.execute doesn't expose uniformly.
function escapeSql(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
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
        { err, plugin: manifest.id },
        'plugin migration failed — skipping plugin',
      );
      continue;
    }

    await fastify.register(
      async (scoped) => {
        // Auto-mount a /by-slug/:slug route per federation-handled kind
        // so the cross-Tower /embeds/resolve proxy has something to dial.
        // Plugin authors only provide resolveBySlug; the transport is
        // handled here.
        if (manifest.federationHandlers) {
          const handlers = manifest.federationHandlers;
          for (const kind of Object.keys(handlers)) {
            const handler = handlers[kind];
            scoped.get<{ Params: { slug: string } }>(
              `/${kind}/by-slug/:slug`,
              async (request, reply) => {
                const { slug } = request.params;
                const callerUri = request.actor?.uri;
                const result = await handler.resolveBySlug(slug, {
                  callerUri,
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
      { prefix: `/plugins/${manifest.id}` },
    );

    if (manifest.federationHandlers) {
      for (const kind of Object.keys(manifest.federationHandlers)) {
        federationHandlers.set(kind, manifest.federationHandlers[kind]);
      }
    }

    fastify.log.info({ plugin: manifest.id, version: manifest.version }, 'plugin loaded');
  }
}

export default fp(pluginLoader, {
  name: 'plugin-loader',
  dependencies: ['db'],
});
