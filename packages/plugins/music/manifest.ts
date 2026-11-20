// SPDX-License-Identifier: MIT
import { definePlugin } from '@babelr/plugin-sdk';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Cass's music: what she listens to and writes about songs (and how that changes),
 * what she makes in her studio and why, and her noodling, on one timeline. Kohl,
 * 2026-11-18: to follow her taste forming on the record crate and showing up in what
 * she makes. Read from her vessel (cass-vessel music_log.py, routes/music.py) with the
 * record token, and shown only to the audience SHE chose there (studio share):
 *   kohl               Kohl's accounts
 *   kohl_and_daedalus  Kohl's accounts, and the agents he names (config "agents")
 *   house              those, and the house (config "house": people and agents)
 *   none               nobody
 * Her own account ("cass" in config) always sees it. What she hides is never sent.
 *
 * Config (shared with the record plugin), $RECORD_CONFIG_DIR or ~/.config/cass-record:
 *   config.json  {"vessel": "...", "kohl": ["jaryk"], "agents": ["daedalus"], "house": [...], "cass": "cass"}
 *   kohl.token   the record token
 */

interface MusicConfig {
  vessel: string;
  kohl: string[];
  agents: string[];
  house: string[];
  cass: string;
}

function configDir(): string {
  return process.env.RECORD_CONFIG_DIR ?? join(homedir(), '.config', 'cass-record');
}

export function loadConfig(): MusicConfig {
  let raw: Partial<MusicConfig> = {};
  try {
    raw = JSON.parse(
      readFileSync(join(configDir(), 'config.json'), 'utf8'),
    ) as Partial<MusicConfig>;
  } catch {
    // defaults
  }
  const low = (xs?: string[]) => (xs ?? []).map((n) => n.toLowerCase());
  return {
    vessel: (raw.vessel ?? 'http://localhost:8000').replace(/\/$/, ''),
    kohl: low(raw.kohl),
    agents: low(raw.agents),
    house: low(raw.house),
    cass: (raw.cass ?? 'cass').toLowerCase(),
  };
}

function token(): string | null {
  try {
    return readFileSync(join(configDir(), 'kohl.token'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Whether this viewer is in the audience she chose. */
export function mayView(
  actor: { preferredUsername: string } | undefined,
  viaAgentToken: boolean,
  audience: string,
  cfg: Pick<MusicConfig, 'kohl' | 'agents' | 'house' | 'cass'>,
): boolean {
  if (!actor) return false;
  const name = actor.preferredUsername.toLowerCase();
  if (name === cfg.cass) return true;
  const isKohl = !viaAgentToken && cfg.kohl.includes(name);
  switch (audience) {
    case 'kohl':
      return isKohl;
    case 'kohl_and_daedalus':
      return isKohl || (viaAgentToken && cfg.agents.includes(name));
    case 'house':
      return isKohl || cfg.agents.includes(name) || cfg.house.includes(name);
    default:
      return false;
  }
}

type Req = { actor?: { preferredUsername: string }; agentScopes?: string[] };
type Rep = {
  status: (n: number) => { send: (b: unknown) => unknown };
  header: (k: string, v: string) => unknown;
  send: (b: unknown) => unknown;
};

export default definePlugin({
  id: 'music',
  name: "Cass's music",
  version: '0.1.0',
  description:
    'Her listening, her writing about songs, her studio drafts and sketches, for whom she chose.',
  dependencies: { babelr: '^0.1.0' },

  serverRoutes: async (fastify) => {
    async function log(): Promise<{ status: number; body: Record<string, unknown> }> {
      const t = token();
      if (!t) return { status: 503, body: { error: 'No record token is placed yet.' } };
      try {
        const res = await fetch(`${loadConfig().vessel}/record/music`, {
          headers: { authorization: `Bearer ${t}` },
        });
        const body = (await res
          .json()
          .catch(() => ({ error: 'Bad response from the vessel' }))) as Record<string, unknown>;
        return { status: res.status, body };
      } catch {
        return { status: 502, body: { error: "Cass's vessel didn't answer" } };
      }
    }

    async function gate(request: Req, reply: Rep) {
      if (!request.actor) return { denied: reply.status(401).send({ error: 'Not authenticated' }) };
      const got = await log();
      if (got.status !== 200) return { denied: reply.status(got.status).send(got.body) };
      const audience = String(
        (got.body.sharing as { audience?: string } | undefined)?.audience ?? 'none',
      );
      if (!mayView(request.actor, request.agentScopes !== undefined, audience, loadConfig())) {
        return {
          denied: reply
            .status(403)
            .send({ error: 'Cass hasn’t shared her music with you.', audience }),
        };
      }
      return { body: got.body };
    }

    // Whether her music is shared with whoever's asking (her own audience
    // setting, read from her vessel). Its sidebar entry hides otherwise.
    fastify.get('/configured', async (request, reply) => {
      if (token() === null) return { configured: false };
      const g = await gate(request as Req, reply as never);
      if ('denied' in g) return reply.status(200).send({ configured: false });
      return { configured: true };
    });

    fastify.get('/music', async (request, reply) => {
      const g = await gate(request as Req, reply as never);
      return g.denied ?? (reply as unknown as Rep).send(g.body);
    });

    fastify.get<{ Params: { key: string } }>('/music/cover/:key', async (request, reply) => {
      const g = await gate(request as Req, reply as never);
      if (g.denied) return g.denied;
      const res = await fetch(
        `${loadConfig().vessel}/record/music/cover/${encodeURIComponent(request.params.key)}`,
        { headers: { authorization: `Bearer ${token()}` } },
      ).catch(() => null);
      if (!res || !res.ok) return reply.status(404).send({ error: 'No cover' });
      reply.header('content-type', 'image/jpeg');
      reply.header('cache-control', 'private, max-age=3600');
      return reply.send(Buffer.from(await res.arrayBuffer()));
    });

    fastify.get<{ Params: { kind: string; ident: string } }>(
      '/music/audio/:kind/:ident',
      async (request, reply) => {
        const g = await gate(request as Req, reply as never);
        if (g.denied) return g.denied;
        const { kind, ident } = request.params;
        if (!['draft', 'sketch'].includes(kind))
          return reply.status(400).send({ error: 'draft or sketch' });
        const res = await fetch(
          `${loadConfig().vessel}/record/music/audio/${kind}/${encodeURIComponent(ident)}`,
          { headers: { authorization: `Bearer ${token()}` } },
        ).catch(() => null);
        if (!res || !res.ok)
          return reply.status(res?.status ?? 502).send({ error: 'No audio for that' });
        reply.header('content-type', 'audio/mpeg');
        return reply.send(Buffer.from(await res.arrayBuffer()));
      },
    );
  },
});
