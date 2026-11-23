// SPDX-License-Identifier: MIT
import { definePlugin } from '@babelr/plugin-sdk';
import { loadConfig, type DaemonConf } from '@babelr/plugin-panel';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * The Daybook (Kohl, 2026-11-23: "a unified calendar where I can inspect all
 * autonomous activity, journals, and other self-model modifications made, day by
 * day ... one plugin, with tabs ... for managing multiple daemons"). A house
 * plugin, not one daemon's: it reads each daemon's daybook from her vessel
 * (cass-vessel daybook.py, GET /record/daybook) with her record token, the same
 * daemons and tokens as the panel plugin (~/.config/house-panel).
 *
 * Her record is Kohl's to read; her sessions, journals, dreams and self-model
 * changes are in it only after her own yes (the vessel decides that). Who sees
 * the Daybook: Kohl's accounts, and each daemon her own entries.
 */

function token(d: DaemonConf): string | null {
  try {
    const dir = process.env.PANEL_CONFIG_DIR ?? join(homedir(), '.config', 'house-panel');
    return readFileSync(isAbsolute(d.token) ? d.token : join(dir, d.token), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** The daemons whose daybook this viewer may read. */
export function readable(
  actor: { preferredUsername: string } | undefined,
  viaAgentToken: boolean,
  cfg: ReturnType<typeof loadConfig>,
): string[] {
  if (!actor) return [];
  const name = actor.preferredUsername.toLowerCase();
  const all = Object.keys(cfg.daemons);
  if (!viaAgentToken && cfg.kohl.includes(name)) return all;
  return all.filter((d) => d === name);
}

type Req = { actor?: { preferredUsername: string }; agentScopes?: string[] };

export default definePlugin({
  id: 'daybook',
  name: 'Daybook',
  version: '0.1.0',
  description: 'Every daemon, day by day: her record, and what she said yes to showing.',
  dependencies: { babelr: '^0.1.0' },

  serverRoutes: async (fastify) => {
    fastify.get<{ Querystring: { days?: string } }>('/daybook', async (request, reply) => {
      const r = request as unknown as Req;
      if (!r.actor) return reply.status(401).send({ error: 'Not authenticated' });
      const cfg = loadConfig();
      const names = readable(r.actor, r.agentScopes !== undefined, cfg);
      const days = Math.max(1, Math.min(120, Number(request.query.days) || 7));
      const daemons = await Promise.all(
        names.map(async (name) => {
          const d = cfg.daemons[name];
          const t = token(d);
          if (!t) return { name, label: d.label, error: 'No record token placed for her yet.' };
          try {
            const res = await fetch(`${d.vessel}/record/daybook?days=${days}`, {
              headers: { authorization: `Bearer ${t}` },
            });
            const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
            if (!res.ok)
              return { name, label: d.label, error: `Her vessel answered ${res.status}` };
            return { name, label: d.label, ...body };
          } catch {
            return { name, label: d.label, error: `${d.label}'s vessel didn't answer` };
          }
        }),
      );
      return { days, daemons };
    });
  },
});
