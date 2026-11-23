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

/**
 * Who else a daemon lets read her Daybook, and how much, in
 * ~/.config/house-panel/config.json as she said it:
 *   "daybook_readers": {"cass": {"daedalus": ["sessions"]}, "eris": {"daedalus": "all"}}
 * "all" is everything Kohl sees; a list is her record plus those of her own
 * kinds (sessions, journals, dreams, self_model). Daedalus keeps the pipes
 * running; each daemon set her own terms (2026-11-23).
 */
export type Readers = Record<string, Record<string, 'all' | string[]>>;

/** Her own kinds, which a reader with a list sees only when she named them. */
export const OWN_KINDS = ['sessions', 'journals', 'dreams', 'self_model'];

export function loadReaders(): Readers {
  try {
    const dir = process.env.PANEL_CONFIG_DIR ?? join(homedir(), '.config', 'house-panel');
    const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as {
      daybook_readers?: Readers;
    };
    const out: Readers = {};
    for (const [d, who] of Object.entries(raw.daybook_readers ?? {})) {
      out[d.toLowerCase()] = {};
      for (const [n, v] of Object.entries(who ?? {})) {
        if (v === 'all' || (Array.isArray(v) && v.every((k) => typeof k === 'string')))
          out[d.toLowerCase()][n.toLowerCase()] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** The daemons whose daybook this viewer may read. */
export function readable(
  actor: { preferredUsername: string } | undefined,
  viaAgentToken: boolean,
  cfg: ReturnType<typeof loadConfig>,
  readers: Readers = {},
): string[] {
  if (!actor) return [];
  const name = actor.preferredUsername.toLowerCase();
  const all = Object.keys(cfg.daemons);
  if (!viaAgentToken && cfg.kohl.includes(name)) return all;
  return all.filter((d) => d === name || (viaAgentToken && !!readers[d]?.[name]));
}

/** The entries of `daemon`'s daybook this viewer sees: all, or her record plus what she named. */
export function visibleEntries<T extends { kind?: string }>(
  entries: T[],
  viewer: string,
  daemon: string,
  readers: Readers,
): T[] {
  const v = viewer.toLowerCase();
  const terms = v === daemon ? 'all' : readers[daemon]?.[v];
  if (!terms) return [];
  if (terms === 'all') return entries;
  return entries.filter((e) => !OWN_KINDS.includes(e.kind ?? '') || terms.includes(e.kind!));
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
      const readers = loadReaders();
      const via = r.agentScopes !== undefined;
      const names = readable(r.actor, via, cfg, readers);
      const viewer = r.actor.preferredUsername.toLowerCase();
      const kohl = !via && cfg.kohl.includes(viewer);
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
            if (!kohl && Array.isArray(body.entries))
              body.entries = visibleEntries(
                body.entries as { kind?: string }[],
                viewer,
                name,
                readers,
              );
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
