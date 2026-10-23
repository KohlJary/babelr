// SPDX-License-Identifier: Hippocratic-3.0
import { definePlugin } from '@babelr/plugin-sdk';
import { sql, type SQL } from 'drizzle-orm';
import { lstat, open, readdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/**
 * Blinds — grade blind eval answers inside Babelr.
 *
 * A sibling of the polls plugin, built on the same SDK with polls as
 * the pattern, but deliberately NOT polls. Polls are single-choice and
 * broadcast vote counts to every WS subscriber. Grading needs a
 * multi-field rubric per answer, exactly one grader, and nothing
 * visible to anyone else. Bolting that onto polls would mean undoing
 * the two things polls is built around.
 *
 * Blinding rules (tested in packages/server/src/__tests__/plugin-blinds.test.ts):
 *
 *   - A bundle is a directory `$BLINDS_DIR/<round>/`. The server reads
 *     ONLY `blind.json` from it (see `bundleFile`, which refuses every
 *     other filename, and refuses symlinks). key.json / raw.json may
 *     sit in the same directory; they are never opened. The only other
 *     file the server touches is the `ratings.json` it writes on lock,
 *     opened write-exclusive.
 *   - One grader: env BLINDS_GRADER, a local Babelr username. Every
 *     route, reads included, is 403 for anyone else (and for everyone
 *     when BLINDS_GRADER is unset). No federation handler is
 *     registered, so /embeds/resolve can't reach a round either.
 *   - No WS broadcast. Ratings never leave the grader's own requests.
 *   - Answer text is rendered raw, never through the translation
 *     pipeline (<T>), so blinded text is never sent to a provider or
 *     reworded.
 *   - Ratings live in Postgres, autosaved per field. POST .../lock
 *     freezes the round (409 on any later write) and exports
 *     `ratings.json` keyed by opaque label, with locked_at.
 *     Unblinding never happens in Babelr: robokohl's `blinds unblind`
 *     joins ratings.json with the key, outside this server.
 *
 * blind.json (written by robokohl/blinds.py `export`):
 *   {
 *     round: string,
 *     title: string,
 *     prompts: [{ id, text }],
 *     answers: [{ label, prompt_id, text }],     // labels opaque, e.g. P1-A
 *     rubric:  [{ id, label, type: 'bool'|'scale', min?, max?, help? }],
 *     rank?:   boolean                            // rank answers per prompt
 *   }
 * Unknown fields are dropped on load; only the fields above reach the
 * client.
 */

// ── Bundle format ────────────────────────────────────────────────────

export interface BlindPrompt {
  id: string;
  text: string;
}
export interface BlindAnswer {
  label: string;
  prompt_id: string;
  text: string;
}
export interface BlindRubricField {
  id: string;
  label: string;
  type: 'bool' | 'scale';
  min?: number;
  max?: number;
  help?: string;
}
export interface BlindBundle {
  round: string;
  title: string;
  prompts: BlindPrompt[];
  answers: BlindAnswer[];
  rubric: BlindRubricField[];
  rank: boolean;
}

export type RatingValue = boolean | number;

export interface AnswerRating {
  fields: Record<string, RatingValue>;
  note: string;
}

export interface BlindRoundPayload {
  bundle: BlindBundle;
  ratings: Record<string, AnswerRating>;
  /** prompt_id -> labels, best first. Present only when bundle.rank. */
  ranks: Record<string, string[]>;
  lockedAt: string | null;
  graded: number;
  total: number;
}

export interface BlindRoundSummary {
  round: string;
  title: string;
  graded: number;
  total: number;
  lockedAt: string | null;
}

/** The one file the server reads from a bundle directory. */
export const BUNDLE_FILE = 'blind.json';
/** The one file the server writes into a bundle directory. */
export const RATINGS_FILE = 'ratings.json';

const ROUND_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MAX_NOTE = 4000;
const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;

export function blindsDir(): string {
  return process.env.BLINDS_DIR || join(homedir(), '.local/share/robokohl-eval/blinds');
}

export function isValidRound(round: string): boolean {
  return ROUND_RE.test(round);
}

export class BundleError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/**
 * Resolve a file inside a round's bundle directory. This is the only
 * path builder the plugin uses, and it only ever hands out blind.json
 * (for reading) or ratings.json (for the lock export). Anything else —
 * key.json, raw.json, '../x' — throws.
 */
export function bundleFile(round: string, name: string, mode: 'read' | 'write'): string {
  const allowed = mode === 'read' ? BUNDLE_FILE : RATINGS_FILE;
  if (name !== allowed) {
    throw new BundleError(`refusing to ${mode} ${name}: only ${allowed} is allowed`, 400);
  }
  if (!isValidRound(round)) throw new BundleError('invalid round name', 400);
  const root = resolve(blindsDir());
  const p = resolve(root, round, name);
  if (!p.startsWith(root + sep)) throw new BundleError('invalid round path', 400);
  return p;
}

function str(v: unknown, what: string, max = 100_000): string {
  if (typeof v !== 'string' || v.length > max) throw new BundleError(`${what} must be a string`, 422);
  return v;
}

function ident(v: unknown, what: string): string {
  const s = str(v, what, 64);
  if (!ID_RE.test(s)) throw new BundleError(`${what} has invalid characters`, 422);
  return s;
}

/** Validate a parsed blind.json and copy out only the known fields. */
export function sanitizeBundle(raw: unknown, round: string): BlindBundle {
  if (!raw || typeof raw !== 'object') throw new BundleError('blind.json is not an object', 422);
  const r = raw as Record<string, unknown>;
  if (r.round !== round) throw new BundleError('blind.json round does not match its directory', 422);
  if (!Array.isArray(r.prompts) || !Array.isArray(r.answers) || !Array.isArray(r.rubric)) {
    throw new BundleError('blind.json needs prompts, answers and rubric arrays', 422);
  }
  const prompts: BlindPrompt[] = r.prompts.map((p: Record<string, unknown>, i: number) => ({
    id: ident(p?.id, `prompts[${i}].id`),
    text: str(p?.text, `prompts[${i}].text`),
  }));
  const promptIds = new Set(prompts.map((p) => p.id));
  if (promptIds.size !== prompts.length) throw new BundleError('duplicate prompt id', 422);

  const answers: BlindAnswer[] = r.answers.map((a: Record<string, unknown>, i: number) => {
    const prompt_id = ident(a?.prompt_id, `answers[${i}].prompt_id`);
    if (!promptIds.has(prompt_id)) throw new BundleError(`answers[${i}] has unknown prompt_id`, 422);
    return {
      label: ident(a?.label, `answers[${i}].label`),
      prompt_id,
      text: str(a?.text, `answers[${i}].text`),
    };
  });
  if (new Set(answers.map((a) => a.label)).size !== answers.length) {
    throw new BundleError('duplicate answer label', 422);
  }

  const rubric: BlindRubricField[] = r.rubric.map((f: Record<string, unknown>, i: number) => {
    const id = ident(f?.id, `rubric[${i}].id`);
    const label = str(f?.label, `rubric[${i}].label`, 500);
    const help = f?.help === undefined ? undefined : str(f.help, `rubric[${i}].help`, 2000);
    if (f?.type === 'bool') return { id, label, type: 'bool', ...(help ? { help } : {}) };
    if (f?.type === 'scale') {
      const min = f.min;
      const max = f.max;
      if (!Number.isInteger(min) || !Number.isInteger(max) || (min as number) >= (max as number) || (max as number) - (min as number) > 10) {
        throw new BundleError(`rubric[${i}] scale needs integer min < max (span <= 10)`, 422);
      }
      return { id, label, type: 'scale', min: min as number, max: max as number, ...(help ? { help } : {}) };
    }
    throw new BundleError(`rubric[${i}].type must be bool or scale`, 422);
  });
  if (rubric.length === 0) throw new BundleError('rubric is empty', 422);
  if (new Set(rubric.map((f) => f.id)).size !== rubric.length) throw new BundleError('duplicate rubric id', 422);

  return {
    round,
    title: typeof r.title === 'string' ? r.title.slice(0, 500) : round,
    prompts,
    answers,
    rubric,
    rank: r.rank === true,
  };
}

/**
 * Read and validate `$BLINDS_DIR/<round>/blind.json`. Opens with
 * O_NOFOLLOW after an lstat so a symlinked blind.json (say, pointing
 * at key.json) is refused rather than followed.
 */
export async function loadBundle(round: string): Promise<BlindBundle> {
  const p = bundleFile(round, BUNDLE_FILE, 'read');
  let st;
  try {
    st = await lstat(p);
  } catch {
    throw new BundleError('round not found', 404);
  }
  if (!st.isFile()) throw new BundleError('blind.json is not a regular file', 422);
  if (st.size > MAX_BUNDLE_BYTES) throw new BundleError('blind.json is too large', 422);
  const fh = await open(p, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let text: string;
  try {
    text = await fh.readFile('utf8');
  } finally {
    await fh.close();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BundleError('blind.json is not valid JSON', 422);
  }
  return sanitizeBundle(parsed, round);
}

/** Round directories that contain a blind.json. Stats only; reads nothing. */
export async function listRoundDirs(): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(blindsDir(), { withFileTypes: true });
  } catch {
    return [];
  }
  const rounds: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !isValidRound(e.name)) continue;
    try {
      const st = await lstat(bundleFile(e.name, BUNDLE_FILE, 'read'));
      if (st.isFile()) rounds.push(e.name);
    } catch {
      // no blind.json — not a round
    }
  }
  return rounds.sort();
}

/** Validate one rubric value against its field. null clears. */
export function checkValue(field: BlindRubricField, value: unknown): RatingValue | null {
  if (value === null) return null;
  if (field.type === 'bool') {
    if (typeof value !== 'boolean') throw new BundleError(`${field.id} takes true/false`, 400);
    return value;
  }
  if (!Number.isInteger(value) || (value as number) < field.min! || (value as number) > field.max!) {
    throw new BundleError(`${field.id} takes an integer ${field.min}–${field.max}`, 400);
  }
  return value as number;
}

export function isGraded(bundle: BlindBundle, rating: AnswerRating | undefined): boolean {
  if (!rating) return false;
  return bundle.rubric.every((f) => rating.fields[f.id] !== undefined);
}

/** The ratings.json the lock route exports. Keyed by opaque label. */
export function buildRatingsExport(
  bundle: BlindBundle,
  ratings: Record<string, AnswerRating>,
  ranks: Record<string, string[]>,
  lockedAt: string,
  grader: string,
) {
  const out: Record<string, { prompt_id: string; fields: Record<string, RatingValue>; note: string }> = {};
  for (const a of bundle.answers) {
    const r = ratings[a.label];
    out[a.label] = { prompt_id: a.prompt_id, fields: r?.fields ?? {}, note: r?.note ?? '' };
  }
  return {
    round: bundle.round,
    locked_at: lockedAt,
    grader,
    rubric: bundle.rubric,
    ratings: out,
    ...(bundle.rank ? { ranks } : {}),
  };
}

// ── DB rows ──────────────────────────────────────────────────────────

interface RatingRow {
  label: string;
  fields: Record<string, RatingValue> | string;
  note: string;
}
interface RankRow {
  prompt_id: string;
  ordering: string[] | string;
}
interface RoundRow {
  round: string;
  locked_at: string | Date | null;
}

function jsonCol<T>(v: T | string): T {
  return typeof v === 'string' ? (JSON.parse(v) as T) : v;
}

function iso(v: string | Date | null): string | null {
  if (v === null || v === undefined) return null;
  return new Date(v).toISOString();
}

export default definePlugin({
  id: 'blinds',
  name: 'Blinds',
  version: '0.1.0',
  description: 'Grade blind eval answers, one grader, one answer at a time. [[blind:<round>]] embeds.',
  dependencies: { babelr: '^0.1.0' },

  migrations: [
    {
      id: 1,
      name: 'init',
      up: `
        CREATE TABLE IF NOT EXISTS plugin_blinds_rounds (
          round TEXT PRIMARY KEY,
          locked_at TIMESTAMPTZ,
          locked_by TEXT
        );

        CREATE TABLE IF NOT EXISTS plugin_blinds_ratings (
          round TEXT NOT NULL,
          label TEXT NOT NULL,
          fields JSONB NOT NULL DEFAULT '{}'::jsonb,
          note TEXT NOT NULL DEFAULT '',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (round, label)
        );

        CREATE TABLE IF NOT EXISTS plugin_blinds_ranks (
          round TEXT NOT NULL,
          prompt_id TEXT NOT NULL,
          ordering JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (round, prompt_id)
        );
      `,
    },
  ],

  serverRoutes: async (fastify) => {
    // Gate every route. 403 for anyone who isn't the one local grader,
    // including reads and including unauthenticated requests, so a
    // non-grader can't even learn whether a round exists.
    fastify.addHook('onRequest', async (request, reply) => {
      const grader = process.env.BLINDS_GRADER;
      const a = request.actor;
      if (!grader || !a || a.local !== true || a.preferredUsername !== grader) {
        return reply.status(403).send({ error: 'Blinds are visible to the grader only' });
      }
      reply.header('Cache-Control', 'no-store');
    });

    function fail(reply: { status: (n: number) => { send: (b: unknown) => unknown } }, err: unknown) {
      if (err instanceof BundleError) return reply.status(err.status).send({ error: err.message });
      throw err;
    }

    async function lockedAt(round: string): Promise<string | null> {
      const rows = (await fastify.db.execute(
        sql`SELECT round, locked_at FROM plugin_blinds_rounds WHERE round = ${round}`,
      )) as unknown as RoundRow[];
      return iso(rows[0]?.locked_at ?? null);
    }

    async function loadRatings(round: string): Promise<Record<string, AnswerRating>> {
      const rows = (await fastify.db.execute(
        sql`SELECT label, fields, note FROM plugin_blinds_ratings WHERE round = ${round}`,
      )) as unknown as RatingRow[];
      const out: Record<string, AnswerRating> = {};
      for (const r of rows) out[r.label] = { fields: jsonCol(r.fields), note: r.note };
      return out;
    }

    async function loadRanks(round: string): Promise<Record<string, string[]>> {
      const rows = (await fastify.db.execute(
        sql`SELECT prompt_id, ordering FROM plugin_blinds_ranks WHERE round = ${round}`,
      )) as unknown as RankRow[];
      const out: Record<string, string[]> = {};
      for (const r of rows) out[r.prompt_id] = jsonCol(r.ordering);
      return out;
    }

    async function payload(round: string): Promise<BlindRoundPayload> {
      const bundle = await loadBundle(round);
      const all = await loadRatings(round);
      const ratings: Record<string, AnswerRating> = {};
      for (const a of bundle.answers) if (all[a.label]) ratings[a.label] = all[a.label];
      return {
        bundle,
        ratings,
        ranks: bundle.rank ? await loadRanks(round) : {},
        lockedAt: await lockedAt(round),
        graded: bundle.answers.filter((a) => isGraded(bundle, ratings[a.label])).length,
        total: bundle.answers.length,
      };
    }

    async function assertWritable(round: string) {
      if (await lockedAt(round)) throw new BundleError('Round is locked', 409);
    }

    fastify.get('/rounds', async () => {
      const out: BlindRoundSummary[] = [];
      for (const round of await listRoundDirs()) {
        try {
          const p = await payload(round);
          out.push({ round, title: p.bundle.title, graded: p.graded, total: p.total, lockedAt: p.lockedAt });
        } catch {
          // malformed bundle — skip in the list; GET /rounds/:round reports why
        }
      }
      return out;
    });

    fastify.get<{ Params: { round: string } }>('/rounds/:round', async (request, reply) => {
      try {
        return await payload(request.params.round);
      } catch (err) {
        return fail(reply, err);
      }
    });

    // Autosave one field (or the note) for one answer.
    fastify.put<{
      Params: { round: string; label: string };
      Body: { field?: string; value?: unknown; note?: unknown };
    }>('/rounds/:round/ratings/:label', async (request, reply) => {
      try {
        const { round, label } = request.params;
        const bundle = await loadBundle(round);
        if (!bundle.answers.some((a) => a.label === label)) throw new BundleError('unknown answer label', 404);
        await assertWritable(round);
        const body = request.body ?? {};
        const hasField = typeof body.field === 'string';
        const hasNote = body.note !== undefined;
        if (hasField === hasNote) throw new BundleError('send exactly one of {field, value} or {note}', 400);
        if (hasField) {
          const field = bundle.rubric.find((f) => f.id === body.field);
          if (!field) throw new BundleError('unknown rubric field', 400);
          if (body.value === undefined) throw new BundleError('value is required (null clears)', 400);
          const v = checkValue(field, body.value);
          if (v === null) {
            await fastify.db.execute(
              sql`UPDATE plugin_blinds_ratings SET fields = fields - ${field.id}, updated_at = NOW()
                  WHERE round = ${round} AND label = ${label}`,
            );
          } else {
            const patch = JSON.stringify({ [field.id]: v });
            await fastify.db.execute(
              sql`INSERT INTO plugin_blinds_ratings (round, label, fields)
                  VALUES (${round}, ${label}, ${patch}::jsonb)
                  ON CONFLICT (round, label) DO UPDATE
                  SET fields = plugin_blinds_ratings.fields || EXCLUDED.fields, updated_at = NOW()`,
            );
          }
        } else {
          if (typeof body.note !== 'string' || body.note.length > MAX_NOTE) {
            throw new BundleError(`note must be a string up to ${MAX_NOTE} chars`, 400);
          }
          await fastify.db.execute(
            sql`INSERT INTO plugin_blinds_ratings (round, label, note)
                VALUES (${round}, ${label}, ${body.note})
                ON CONFLICT (round, label) DO UPDATE
                SET note = EXCLUDED.note, updated_at = NOW()`,
          );
        }
        const ratings = await loadRatings(round);
        return { label, rating: ratings[label] ?? { fields: {}, note: '' } };
      } catch (err) {
        return fail(reply, err);
      }
    });

    // Save the order of one prompt's answers, best first.
    fastify.put<{ Params: { round: string; promptId: string }; Body: { order?: unknown } }>(
      '/rounds/:round/ranks/:promptId',
      async (request, reply) => {
        try {
          const { round, promptId } = request.params;
          const bundle = await loadBundle(round);
          if (!bundle.rank) throw new BundleError('this round has no rank step', 400);
          if (!bundle.prompts.some((p) => p.id === promptId)) throw new BundleError('unknown prompt', 404);
          await assertWritable(round);
          const order = request.body?.order;
          const labels = bundle.answers.filter((a) => a.prompt_id === promptId).map((a) => a.label);
          if (
            !Array.isArray(order) ||
            order.length !== labels.length ||
            new Set(order).size !== order.length ||
            !order.every((l) => typeof l === 'string' && labels.includes(l))
          ) {
            throw new BundleError("order must list each of this prompt's answer labels once", 400);
          }
          await fastify.db.execute(
            sql`INSERT INTO plugin_blinds_ranks (round, prompt_id, ordering)
                VALUES (${round}, ${promptId}, ${JSON.stringify(order)}::jsonb)
                ON CONFLICT (round, prompt_id) DO UPDATE
                SET ordering = EXCLUDED.ordering, updated_at = NOW()`,
          );
          return { promptId, order };
        } catch (err) {
          return fail(reply, err);
        }
      },
    );

    // Freeze the round and export ratings.json. The DB lock and the
    // file write share a transaction: if the file can't be written
    // (including because one already exists) the lock rolls back.
    fastify.post<{ Params: { round: string } }>('/rounds/:round/lock', async (request, reply) => {
      try {
        const { round } = request.params;
        const bundle = await loadBundle(round);
        const grader = request.actor!.preferredUsername;
        const target = bundleFile(round, RATINGS_FILE, 'write');
        const lockedIso = await fastify.db.transaction(async (tx: { execute: (q: SQL) => PromiseLike<unknown> }) => {
          await tx.execute(
            sql`INSERT INTO plugin_blinds_rounds (round) VALUES (${round}) ON CONFLICT (round) DO NOTHING`,
          );
          const rows = (await tx.execute(
            sql`UPDATE plugin_blinds_rounds SET locked_at = NOW(), locked_by = ${grader}
                WHERE round = ${round} AND locked_at IS NULL
                RETURNING round, locked_at`,
          )) as unknown as RoundRow[];
          if (rows.length === 0) throw new BundleError('Round is already locked', 409);
          const at = iso(rows[0].locked_at)!;
          const all = (await tx.execute(
            sql`SELECT label, fields, note FROM plugin_blinds_ratings WHERE round = ${round}`,
          )) as unknown as RatingRow[];
          const ratings: Record<string, AnswerRating> = {};
          for (const r of all) ratings[r.label] = { fields: jsonCol(r.fields), note: r.note };
          const rankRows = (await tx.execute(
            sql`SELECT prompt_id, ordering FROM plugin_blinds_ranks WHERE round = ${round}`,
          )) as unknown as RankRow[];
          const ranks: Record<string, string[]> = {};
          for (const r of rankRows) ranks[r.prompt_id] = jsonCol(r.ordering);
          const doc = buildRatingsExport(bundle, ratings, ranks, at, grader);
          let fh;
          try {
            // 'wx' semantics: never overwrite an existing ratings.json.
            fh = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
              throw new BundleError('ratings.json already exists; refusing to overwrite', 409);
            }
            throw e;
          }
          try {
            await fh.writeFile(JSON.stringify(doc, null, 2) + '\n', 'utf8');
          } finally {
            await fh.close();
          }
          return at;
        });
        return { round, lockedAt: lockedIso, file: RATINGS_FILE };
      } catch (err) {
        return fail(reply, err);
      }
    });
  },

  // Deliberately no federationHandlers: a remote Tower must never be
  // able to resolve a round. setupClient lives in client-entry.ts.
});
