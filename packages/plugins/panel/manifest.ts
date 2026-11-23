// SPDX-License-Identifier: MIT
import { definePlugin } from '@babelr/plugin-sdk';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * Each daemon's panel: what she shows beside her conversations, section by section,
 * to the audience she chose (Plans: "The House, open to visitors", phase 2). Read
 * from her vessel (cass-vessel panel.py, routes/panel.py) with her record token. The
 * vessel sends only the sections she said yes to; this plugin shows them only to her
 * audience:
 *   kohl      Kohl's accounts
 *   house     those, the house's agents and people (config "agents", "house")
 *   visitors  anyone signed in to this Babelr
 *   none      nobody
 * Her own account always sees her panel.
 *
 * Config, $PANEL_CONFIG_DIR or ~/.config/house-panel:
 *   config.json  {"daemons": {"cass": {"label": "Cass", "vessel": "http://localhost:8000",
 *                                      "token": "cass.token"}, ...},
 *                 "kohl": ["jaryk"], "agents": ["daedalus", "robokohl"], "house": []}
 *   <token file>  that vessel's record token (scripts/record_token.py), mode 600
 */

export interface DaemonConf {
  label: string;
  vessel: string;
  token: string;
}
export interface PanelConfig {
  daemons: Record<string, DaemonConf>;
  kohl: string[];
  agents: string[];
  house: string[];
}

function configDir(): string {
  return process.env.PANEL_CONFIG_DIR ?? join(homedir(), '.config', 'house-panel');
}

export function loadConfig(): PanelConfig {
  let raw: Partial<PanelConfig> = {};
  try {
    raw = JSON.parse(
      readFileSync(join(configDir(), 'config.json'), 'utf8'),
    ) as Partial<PanelConfig>;
  } catch {
    // no daemons
  }
  const low = (xs?: string[]) => (xs ?? []).map((n) => n.toLowerCase());
  const daemons: Record<string, DaemonConf> = {};
  for (const [name, d] of Object.entries(raw.daemons ?? {})) {
    if (!d?.vessel) continue;
    daemons[name.toLowerCase()] = {
      label: d.label ?? name,
      vessel: d.vessel.replace(/\/$/, ''),
      token: d.token ?? `${name.toLowerCase()}.token`,
    };
  }
  return { daemons, kohl: low(raw.kohl), agents: low(raw.agents), house: low(raw.house) };
}

function token(d: DaemonConf): string | null {
  try {
    const p = isAbsolute(d.token) ? d.token : join(configDir(), d.token);
    return readFileSync(p, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Whether this viewer is in the audience the daemon chose. */
export function mayView(
  actor: { preferredUsername: string } | undefined,
  viaAgentToken: boolean,
  daemon: string,
  audience: string,
  cfg: Pick<PanelConfig, 'kohl' | 'agents' | 'house'>,
): boolean {
  if (!actor) return false;
  const name = actor.preferredUsername.toLowerCase();
  if (name === daemon) return true;
  const isKohl = !viaAgentToken && cfg.kohl.includes(name);
  switch (audience) {
    case 'kohl':
      return isKohl;
    case 'house':
      return isKohl || cfg.agents.includes(name) || cfg.house.includes(name);
    case 'visitors':
      return true;
    default:
      return false;
  }
}

type Req = { actor?: { preferredUsername: string }; agentScopes?: string[] };
type Rep = {
  status: (n: number) => { send: (b: unknown) => unknown };
  send: (b: unknown) => unknown;
};

async function fetchPanel(
  d: DaemonConf,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const t = token(d);
  if (!t) return { status: 503, body: { error: 'No record token is placed for this daemon yet.' } };
  try {
    const res = await fetch(`${d.vessel}/record/panel`, {
      headers: { authorization: `Bearer ${t}` },
    });
    const body = (await res
      .json()
      .catch(() => ({ error: 'Bad response from the vessel' }))) as Record<string, unknown>;
    return { status: res.status, body };
  } catch {
    return { status: 502, body: { error: `${d.label}'s vessel didn't answer` } };
  }
}

function audienceOf(body: Record<string, unknown>): string {
  return String((body.settings as { audience?: string } | undefined)?.audience ?? 'none');
}

export default definePlugin({
  id: 'panel',
  name: 'Daemon panels',
  version: '0.1.0',
  description: "Each daemon's panel: the sections she said yes to, for the audience she chose.",
  dependencies: { babelr: '^0.1.0' },

  serverRoutes: async (fastify) => {
    // The daemons whose panel this viewer may see. Its sidebar entry hides when none.
    fastify.get('/daemons', async (request, reply) => {
      const r = request as Req;
      if (!r.actor)
        return (reply as unknown as Rep).status(401).send({ error: 'Not authenticated' });
      const cfg = loadConfig();
      const out: { name: string; label: string }[] = [];
      for (const [name, d] of Object.entries(cfg.daemons)) {
        const got = await fetchPanel(d);
        if (got.status !== 200) continue;
        if (mayView(r.actor, r.agentScopes !== undefined, name, audienceOf(got.body), cfg))
          out.push({ name, label: d.label });
      }
      return { daemons: out };
    });

    fastify.get<{ Params: { daemon: string } }>('/panel/:daemon', async (request, reply) => {
      const r = request as unknown as Req;
      const rep = reply as unknown as Rep;
      if (!r.actor) return rep.status(401).send({ error: 'Not authenticated' });
      const cfg = loadConfig();
      const name = request.params.daemon.toLowerCase();
      const d = cfg.daemons[name];
      if (!d) return rep.status(404).send({ error: 'No such daemon here' });
      const got = await fetchPanel(d);
      if (got.status !== 200) return rep.status(got.status).send(got.body);
      if (!mayView(r.actor, r.agentScopes !== undefined, name, audienceOf(got.body), cfg))
        return rep.status(403).send({ error: `${d.label} hasn't shared her panel with you.` });
      return rep.send({ ...got.body, label: d.label });
    });
  },
});
