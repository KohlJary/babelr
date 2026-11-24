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
 *
 * Every daemon has a room (Kohl, 2026-11-24: GeoCass pages for each daemon,
 * not only Cass). Cass's is the directory itself, as before; another
 * daemon's is a subdirectory named for her (eris/config.json with her
 * vessel, eris/kohl.token, ...), reached at /d/<name>/... . The kohl list
 * comes from the top config.json for everyone. No directory, no room: the
 * door stays hidden until her vessel minted a token for that audience.
 */

type Audience = 'kohl' | 'house';

interface RoomConfig {
  vessel: string;
  kohl: string[];
}

function configDir(): string {
  return process.env.ROOM_CONFIG_DIR ?? join(homedir(), '.config', 'cass-room');
}

const DAEMON_NAME = /^[a-z0-9_-]{1,40}$/;

/** Where a daemon's room config lives: Cass's is the top directory. */
export function daemonDir(daemon: string): string | null {
  const name = daemon.toLowerCase();
  if (!DAEMON_NAME.test(name)) return null;
  return name === 'cass' ? configDir() : join(configDir(), name);
}

function readJson(path: string): Partial<RoomConfig> {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Partial<RoomConfig>;
  } catch {
    return {};
  }
}

function loadConfig(daemon = 'cass'): RoomConfig {
  const top = readJson(join(configDir(), 'config.json'));
  const dir = daemonDir(daemon);
  const own = dir ? readJson(join(dir, 'config.json')) : {};
  return {
    vessel: (own.vessel ?? top.vessel ?? 'http://localhost:8000').replace(/\/$/, ''),
    kohl: (top.kohl ?? []).map((n) => n.toLowerCase()),
  };
}

function tokenFor(audience: Audience, daemon = 'cass'): string | null {
  const dir = daemonDir(daemon);
  if (!dir) return null;
  try {
    const t = readFileSync(join(dir, `${audience}.token`), 'utf8').trim();
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
  name: 'Rooms',
  version: '0.2.0',
  description:
    'What each daemon chose to share: paintings, music, writing, journals, her day plan, agenda and GeoCass homepage.',
  dependencies: { babelr: '^0.1.0' },

  serverRoutes: async (fastify) => {
    // Every route exists twice: as before (Cass's room) and under /d/:daemon.
    type DaemonParams = { daemon?: string };
    const daemonOf = (request: unknown) =>
      ((request as { params?: DaemonParams }).params?.daemon ?? 'cass').toLowerCase();
    const both = (path: string) => [path, `/d/:daemon${path}`];

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
      const daemon = daemonOf(request);
      if (!daemonDir(daemon)) return reply.status(404).send({ error: 'Not in the room' });
      const cfg = loadConfig(daemon);
      const audience = audienceOf(request.actor, request.agentScopes !== undefined, cfg.kohl);
      const token = audience ? tokenFor(audience, daemon) : null;
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
        return reply.status(502).send({ error: "Her vessel didn't answer" });
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

    // Whether her room is open to whoever's asking. Its sidebar entry hides when
    // it isn't: in a stranger's house (no vessel token), or for someone she
    // hasn't opened it to (no token for their audience). A locked door isn't shown.
    for (const path of both('/configured')) {
      fastify.get(path, async (request) => {
        const r = request as { actor?: { preferredUsername: string }; agentScopes?: string[] };
        const daemon = daemonOf(request);
        const audience = audienceOf(r.actor, r.agentScopes !== undefined, loadConfig(daemon).kohl);
        return { configured: !!audience && tokenFor(audience, daemon) !== null };
      });
    }

    for (const path of both('/overview')) {
      fastify.get(path, async (request, reply) => forward(request, reply as never, ''));
    }

    for (const path of both('/sections/:name')) {
      fastify.get<{ Params: { name: string } }>(path, async (request, reply) =>
        forward(request, reply as never, `/sections/${encodeURIComponent(request.params.name)}`),
      );
    }

    // Images and songs she placed on her homepage's pages.
    for (const route of both('/sections/homepage/assets/:file'))
      fastify.get<{ Params: { file: string } }>(route, async (request, reply) => {
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
      });

    // Piece ids can be paths (writing under creative_output), so a wildcard.
    for (const route of both('/pieces/*'))
      fastify.get<{ Params: { '*': string } }>(route, async (request, reply) => {
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
