// SPDX-License-Identifier: MIT
import { definePlugin } from '@babelr/plugin-sdk';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Cass's room: what she chose to share, read from her vessel's room feed
 * (cass-vessel routes/room.py), read-only.
 *
 * Her terms: nothing appears that she didn't share; Kohl sees it first,
 * the whole house eventually. The vessel enforces that with two room
 * tokens, one per audience. This plugin holds both and picks one per
 * request: Kohl's accounts (by username, from config) read with the
 * "kohl" token; everyone else, agents included, with the "house" token,
 * or sees an empty room if there isn't one yet.
 *
 * Config (all optional), in $ROOM_CONFIG_DIR or ~/.config/cass-room:
 *   config.json   {"vessel": "http://localhost:8000", "kohl": ["jaryk"]}
 *   kohl.token    from cass-vessel scripts/room_token.py kohl "..."
 *   house.token   from cass-vessel scripts/room_token.py house "..."
 */

type Audience = 'kohl' | 'house';

interface RoomConfig {
  vessel: string;
  kohl: string[];
}

function configDir(): string {
  return process.env.ROOM_CONFIG_DIR ?? join(homedir(), '.config', 'cass-room');
}

function loadConfig(): RoomConfig {
  let raw: Partial<RoomConfig> = {};
  try {
    raw = JSON.parse(readFileSync(join(configDir(), 'config.json'), 'utf8')) as Partial<RoomConfig>;
  } catch {
    // defaults
  }
  return {
    vessel: (raw.vessel ?? 'http://localhost:8000').replace(/\/$/, ''),
    kohl: (raw.kohl ?? []).map((n) => n.toLowerCase()),
  };
}

function tokenFor(audience: Audience): string | null {
  try {
    const t = readFileSync(join(configDir(), `${audience}.token`), 'utf8').trim();
    return t || null;
  } catch {
    return null;
  }
}

/** Which audience a request reads as. Agent tokens never read as Kohl. */
export function audienceOf(
  actor: { preferredUsername: string } | undefined,
  viaAgentToken: boolean,
  kohl: string[],
): Audience | null {
  if (!actor) return null;
  if (!viaAgentToken && kohl.includes(actor.preferredUsername.toLowerCase())) return 'kohl';
  return 'house';
}

export default definePlugin({
  id: 'room',
  name: "Cass's room",
  version: '0.1.0',
  description:
    'What Cass chose to share: paintings, music, writing, journals, her day plan and agenda.',
  dependencies: { babelr: '^0.1.0' },

  serverRoutes: async (fastify) => {
    async function forward(
      request: { actor?: { preferredUsername: string }; agentScopes?: string[] },
      reply: {
        status: (n: number) => { send: (b: unknown) => unknown };
        header: (k: string, v: string) => unknown;
        send: (b: unknown) => unknown;
      },
      path: string,
      binary = false,
    ) {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
      const cfg = loadConfig();
      const audience = audienceOf(request.actor, request.agentScopes !== undefined, cfg.kohl);
      const token = audience ? tokenFor(audience) : null;
      if (!token) {
        // No token for this audience: her room isn't open to them yet.
        if (path === '') return reply.send({ audience, sections: [], pieces: [], open: false });
        return reply.status(404).send({ error: 'Not in the room' });
      }
      let res: Response;
      try {
        res = await fetch(`${cfg.vessel}/room${path}`, {
          headers: { authorization: `Bearer ${token}` },
        });
      } catch {
        return reply.status(502).send({ error: "Cass's vessel didn't answer" });
      }
      if (binary && res.ok) {
        reply.header('content-type', res.headers.get('content-type') ?? 'application/octet-stream');
        reply.header('cache-control', 'private, max-age=300');
        return reply.send(Buffer.from(await res.arrayBuffer()));
      }
      const body = await res.json().catch(() => ({ error: 'Bad response from the vessel' }));
      if (path === '' && res.ok) (body as Record<string, unknown>).open = true;
      return reply.status(res.status).send(body);
    }

    fastify.get('/overview', async (request, reply) => forward(request, reply as never, ''));

    fastify.get<{ Params: { name: string } }>('/sections/:name', async (request, reply) =>
      forward(request, reply as never, `/sections/${encodeURIComponent(request.params.name)}`),
    );

    // Images and songs she placed on her homepage's pages.
    fastify.get<{ Params: { file: string } }>(
      '/sections/homepage/assets/:file',
      async (request, reply) => {
        const file = request.params.file;
        if (!file || file === '.' || file === '..' || file.includes('/')) {
          return reply.status(400).send({ error: 'Bad path' });
        }
        return forward(
          request,
          reply as never,
          `/sections/homepage/assets/${encodeURIComponent(file)}`,
          true,
        );
      },
    );

    // Piece ids can be paths (writing under creative_output), so a wildcard.
    fastify.get<{ Params: { '*': string } }>('/pieces/*', async (request, reply) => {
      const rest = request.params['*'] ?? '';
      const isFile = rest.endsWith('/file');
      let segs: string[];
      try {
        segs = rest.split('/').map((seg) => decodeURIComponent(seg));
      } catch {
        return reply.status(400).send({ error: 'Bad path' });
      }
      // No dot segments: fetch would collapse them and leave /room.
      if (segs.length < 2 || segs.some((seg) => seg === '' || seg === '.' || seg === '..')) {
        return reply.status(400).send({ error: 'Bad path' });
      }
      const safe = segs.map((seg) => encodeURIComponent(seg)).join('/');
      return forward(request, reply as never, `/pieces/${safe}`, isFile);
    });
  },
});
