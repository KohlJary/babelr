// SPDX-License-Identifier: MIT
import { definePlugin } from '@babelr/plugin-sdk';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Cass's record: what she planned, asked for, changed in herself and did in
 * the world, dated, attributed and sourced, for diagnostics and to follow her
 * progress (Kohl: not surveillance; she reads it too, with my_record in her
 * vessel). Read from her vessel's record
 * (cass-vessel record.py, routes/record.py). Kohl's: his accounts by
 * username from config, and the agent accounts he names for development
 * (Kohl, 2026-11-17: Daedalus instances too), through their agent tokens.
 * No one else, and no other agent. Her room (plugin "room") stays what she
 * chooses to share; this is the oversight record.
 *
 * Config, in $RECORD_CONFIG_DIR or ~/.config/cass-record:
 *   config.json   {"vessel": "http://localhost:8000", "kohl": ["jaryk"], "agents": ["daedalus"]}
 *   kohl.token    from cass-vessel scripts/record_token.py "babelr record plugin"
 */

interface RecordConfig {
  vessel: string;
  kohl: string[];
  agents: string[];
}

function configDir(): string {
  return process.env.RECORD_CONFIG_DIR ?? join(homedir(), '.config', 'cass-record');
}

function loadConfig(): RecordConfig {
  let raw: Partial<RecordConfig> = {};
  try {
    raw = JSON.parse(
      readFileSync(join(configDir(), 'config.json'), 'utf8'),
    ) as Partial<RecordConfig>;
  } catch {
    // defaults
  }
  return {
    vessel: (raw.vessel ?? 'http://localhost:8000').replace(/\/$/, ''),
    kohl: (raw.kohl ?? []).map((n) => n.toLowerCase()),
    agents: (raw.agents ?? []).map((n) => n.toLowerCase()),
  };
}

function token(): string | null {
  try {
    return readFileSync(join(configDir(), 'kohl.token'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Whether this request may read the record: one of Kohl's accounts (as
 *  himself, not through an agent token), or an agent account he named. */
export function mayRead(
  actor: { preferredUsername: string } | undefined,
  viaAgentToken: boolean,
  kohl: string[],
  agents: string[] = [],
): boolean {
  if (!actor) return false;
  const name = actor.preferredUsername.toLowerCase();
  return viaAgentToken ? agents.includes(name) : kohl.includes(name);
}

export function daysOf(raw: unknown): number {
  const n = Number.parseInt(String(raw ?? '30'), 10);
  return Number.isFinite(n) && n >= 1 && n <= 3650 ? n : 30;
}

export default definePlugin({
  id: 'record',
  name: "Cass's record",
  version: '0.1.0',
  description:
    'What Cass planned, asked for, changed and did: dated, attributed, sourced. Kohl and the agents he names.',
  dependencies: { babelr: '^0.1.0' },

  serverRoutes: async (fastify) => {
    async function forward(
      request: {
        actor?: { preferredUsername: string };
        agentScopes?: string[];
        query: { days?: string; hours?: string };
      },
      reply: {
        status: (n: number) => { send: (b: unknown) => unknown };
        header: (k: string, v: string) => unknown;
        send: (b: unknown) => unknown;
      },
      markdown: boolean,
      review = false,
    ) {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });
      const cfg = loadConfig();
      if (!mayRead(request.actor, request.agentScopes !== undefined, cfg.kohl, cfg.agents)) {
        return reply.status(403).send({ error: 'This record is Kohl’s.' });
      }
      const t = token();
      if (!t) return reply.status(503).send({ error: 'No record token is placed yet.' });
      const days = daysOf(request.query.days);
      const hours = Math.min(
        168,
        Math.max(1, Number.parseInt(String(request.query.hours ?? '24'), 10) || 24),
      );
      const url = review
        ? `${cfg.vessel}/record/review.md?hours=${hours}`
        : `${cfg.vessel}/record${markdown ? '.md' : ''}?days=${days}`;
      let res: Response;
      try {
        res = await fetch(url, {
          headers: { authorization: `Bearer ${t}` },
        });
      } catch {
        return reply.status(502).send({ error: "Cass's vessel didn't answer" });
      }
      if (markdown && res.ok) {
        reply.header('content-type', 'text/markdown; charset=utf-8');
        if (!review) {
          reply.header('content-disposition', `attachment; filename="cass-record-${days}d.md"`);
        }
        return reply.send(await res.text());
      }
      const body = await res.json().catch(() => ({ error: 'Bad response from the vessel' }));
      return reply.status(res.status).send(body);
    }

    // Whether this house has the plugin set up. Its sidebar entry hides when it
    // isn't (a stranger's house, where there's no vessel token to read with).
    fastify.get('/configured', async () => ({ configured: token() !== null }));

    fastify.get<{ Querystring: { days?: string } }>('/record', async (request, reply) =>
      forward(request, reply as never, false),
    );
    fastify.get<{ Querystring: { days?: string } }>('/record.md', async (request, reply) =>
      forward(request, reply as never, true),
    );
    // Kohl's end-of-day review (cass-vessel record.build_review), shown in the tab.
    fastify.get<{ Querystring: { hours?: string } }>('/review.md', async (request, reply) =>
      forward(request, reply as never, true, true),
    );
  },
});
