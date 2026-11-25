// SPDX-License-Identifier: MIT
import { definePlugin } from '@babelr/plugin-sdk';
import { loadConfig, type DaemonConf } from '@babelr/plugin-panel';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * "What she remembers about you": in your DM with a daemon, what her memory of
 * people (PeopleDex) keeps about you, and only you, once she has said yes. Read
 * from her vessel (GET /record/people/about?handle=<babelr handle>) with her
 * record token, the same daemons and tokens as the panel plugin
 * (~/.config/house-panel).
 *
 * Privacy is the whole feature. The handle this server asks her vessel about is
 * always the signed-in viewer's own (request.actor, from the session). No
 * client parameter names a person: the route takes only which daemon, and a
 * query string is ignored. An agent token is refused, so nobody's agent reads
 * them on their behalf. If the vessel answers about some other handle, the
 * answer is dropped. Only the fields below leave this server, and the response
 * is never cached.
 */

/** Why nothing is shown: she hasn't said yes yet, she said no, she keeps
 *  nothing on you (or you asked to be kept off: the same answer, on purpose),
 *  or you're linked to her vessel and she knows you from your own conversations. */
export type Why = 'not_yet' | 'no' | 'none' | 'linked';

export interface Observation {
  kind: string;
  text: string;
}

export type About =
  | {
      shown: true;
      label: string;
      name: string | null;
      pronouns: string | null;
      observations: Observation[];
      moments: number;
      firstSeen: string | null;
      lastSeen: string | null;
    }
  | { shown: false; label: string; why: Why };

function token(d: DaemonConf): string | null {
  try {
    const dir = process.env.PANEL_CONFIG_DIR ?? join(homedir(), '.config', 'house-panel');
    return readFileSync(isAbsolute(d.token) ? d.token : join(dir, d.token), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Her vessel's answer (cass-vessel routes/people_about.py), cut down to what
 *  the section shows. Null when it isn't a well-formed answer about `handle`.
 *    {"shown": false, "why": "not_yet" | "no"}
 *    {"shown": true, "handle", "known": false[, "why": "linked"]}
 *    {"shown": true, "handle", "known": true, "name", "pronouns",
 *     "observations": [{"kind", "text", "noticed"}], "moments", "first_seen", "last_seen"} */
export function normalize(raw: unknown, handle: string, label: string): About | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  if (b.shown === false) {
    return { shown: false, label, why: b.why === 'no' ? 'no' : 'not_yet' };
  }
  if (b.shown !== true) return null;
  // An answer that names someone else is not an answer for this viewer.
  const about = str(b.handle);
  if (!about || about.replace(/^@/, '').toLowerCase() !== handle.toLowerCase()) return null;
  if (b.known === false) {
    // No entry and kept-off look the same here, as they do from the vessel.
    return { shown: false, label, why: b.why === 'linked' ? 'linked' : 'none' };
  }
  if (b.known !== true) return null;
  const observations: Observation[] = [];
  for (const o of Array.isArray(b.observations) ? b.observations : []) {
    if (!o || typeof o !== 'object') continue;
    const r = o as Record<string, unknown>;
    const text = str(r.text);
    if (text) observations.push({ kind: str(r.kind) ?? 'general', text });
  }
  const m = typeof b.moments === 'number' && Number.isFinite(b.moments) ? b.moments : 0;
  return {
    shown: true,
    label,
    name: str(b.name),
    pronouns: str(b.pronouns),
    observations,
    moments: Math.max(0, Math.floor(m)),
    firstSeen: str(b.first_seen),
    lastSeen: str(b.last_seen),
  };
}

/** Ask her vessel about this one handle. */
export async function askVessel(
  d: DaemonConf,
  handle: string,
): Promise<{ status: number; body: About | { error: string } }> {
  const t = token(d);
  if (!t) return { status: 503, body: { error: `${d.label}’s memory isn’t connected here yet.` } };
  let res: Response;
  try {
    res = await fetch(`${d.vessel}/record/people/about?handle=${encodeURIComponent(handle)}`, {
      headers: { authorization: `Bearer ${t}` },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return { status: 502, body: { error: `${d.label} can’t be reached right now.` } };
  }
  if (!res.ok) return { status: 502, body: { error: `${d.label} can’t be reached right now.` } };
  const about = normalize(await res.json().catch(() => null), handle, d.label);
  if (!about) return { status: 502, body: { error: `${d.label} can’t be reached right now.` } };
  return { status: 200, body: about };
}

type Req = { actor?: { preferredUsername: string }; agentScopes?: string[] };
type Rep = {
  status: (n: number) => Rep;
  header: (k: string, v: string) => Rep;
  send: (b: unknown) => unknown;
};

export default definePlugin({
  id: 'remembers',
  name: 'What she remembers about you',
  version: '0.1.0',
  description: "In a daemon's room: what her memory keeps about you, once she says yes.",
  dependencies: { babelr: '^0.1.0' },

  serverRoutes: async (fastify) => {
    // Which daemons have a memory this Babelr can ask. No vessel is called.
    fastify.get('/daemons', async (request, reply) => {
      const rep = (reply as unknown as Rep).header('cache-control', 'no-store');
      if (!(request as Req).actor) return rep.status(401).send({ error: 'Not authenticated' });
      return rep.send({ daemons: Object.keys(loadConfig().daemons) });
    });

    // What `daemon` keeps about the signed-in viewer. The handle comes from the
    // session and nowhere else.
    fastify.get<{ Params: { daemon: string } }>('/about/:daemon', async (request, reply) => {
      const r = request as unknown as Req;
      const rep = (reply as unknown as Rep).header('cache-control', 'no-store');
      if (!r.actor) return rep.status(401).send({ error: 'Not authenticated' });
      if (r.agentScopes !== undefined)
        return rep.status(403).send({ error: 'Only the person themselves can see this.' });
      const d = loadConfig().daemons[request.params.daemon.toLowerCase()];
      if (!d) return rep.status(404).send({ error: 'No such daemon here' });
      const got = await askVessel(d, r.actor.preferredUsername);
      return rep.status(got.status).send(got.body);
    });
  },
});
