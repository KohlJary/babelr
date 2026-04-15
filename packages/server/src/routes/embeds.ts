// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import '../types.ts';
import { signedGet } from '../federation/delivery.ts';
import { getPluginFederationHandler } from '../plugins/plugin-loader.ts';

/**
 * Cross-tower embed resolution. Resolves [[server@tower:kind:slug]]
 * references by proxying a signed GET to the remote tower's by-slug
 * endpoint for the specified kind.
 *
 * The request is signed with the authenticated user's actor key so
 * the remote tower can verify the caller is a known actor. The
 * response is passed through to the client unmodified — the client
 * renders the appropriate embed component based on the `kind`.
 */
export default async function embedRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  fastify.get<{
    Querystring: { server: string; tower: string; kind: string; slug: string };
  }>('/embeds/resolve', async (request, reply) => {
    if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });

    const { tower, kind, slug } = request.query;
    if (!tower || !kind || !slug) {
      return reply.status(400).send({ error: 'tower, kind, and slug are required' });
    }

    // Map embed kind to the remote tower's by-slug endpoint path.
    const kindEndpoints: Record<string, string> = {
      message: '/messages/by-slug',
      event: '/events/by-slug',
      file: '/files/by-slug',
      page: '/wiki/by-slug',
    };

    const endpoint = kindEndpoints[kind];
    if (endpoint) {
      const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
      const url = `${protocol}://${tower}${endpoint}/${encodeURIComponent(slug)}`;
      const result = await signedGet(db, request.actor.id, url);
      if (!result) {
        return reply.status(404).send({ error: 'Content not found or not accessible' });
      }
      return result;
    }

    // Plugin-provided kind: fetch via the plugin's own cross-Tower
    // endpoint at /plugins/<id>/by-slug/<slug>. Each plugin registers
    // that route via its serverRoutes hook; the resolveBySlug handler
    // on this Tower is the same contract a remote Tower would call.
    const pluginHandler = getPluginFederationHandler(kind);
    if (pluginHandler) {
      const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
      const url = `${protocol}://${tower}/plugins/${kind}/by-slug/${encodeURIComponent(slug)}`;
      const result = await signedGet(db, request.actor.id, url);
      if (!result) {
        return reply.status(404).send({ error: 'Content not found or not accessible' });
      }
      return result;
    }

    return reply.status(400).send({ error: `Unknown embed kind: ${kind}` });
  });
}
