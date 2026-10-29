// SPDX-License-Identifier: MIT
import { definePlugin } from '@babelr/plugin-sdk';
import { sql, type SQL } from 'drizzle-orm';
import { lstat, open, readdir, unlink } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/**
 * Blinds — grade blind eval answers inside Babelr.
 *
 * Reusable: anything that writes a blind.json into $BLINDS_DIR/<round>/
 * gets a grader (RoboKohl's arms runs, cass-vessel's benchmark
 * ablations, whatever comes next). The producer keeps the key; Babelr
 * only ever sees opaque labels.
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
 *   - Graders: the round's `graders` (local Babelr usernames), or env
 *     BLINDS_GRADER (comma-separated) when the round names none. Every
 *     route is 403 unless you're signed in locally; a round you don't
 *     grade is a 404, the same as a round that doesn't exist, and
 *     /rounds lists only yours. No federation handler is registered,
 *     so /embeds/resolve can't reach a round either.
 *   - Each grader rates alone: ratings, ranks and the lock are per
 *     grader, and no route returns another grader's. A grader can't
 *     see whether anyone else has started.
 *   - No WS broadcast. Ratings never leave the grader's own requests.
 *   - Answer text is rendered raw, never through the translation
 *     pipeline (<T>), so blinded text is never sent to a provider or
 *     reworded.
 *   - Ratings live in Postgres, autosaved per field. POST .../lock
 *     freezes the round for that grader (409 on any later write) and
 *     exports their ratings keyed by opaque label, with locked_at:
 *     `ratings.json` when the round has one grader, else
 *     `ratings.<grader>.json`.
 *     Babelr never unblinds: robokohl's `blinds unblind` joins
 *     ratings.json with the key, outside this server. unblind refuses
 *     unless ratings.json has locked_at.
 *   - The Unblind button asks; it doesn't open anything. On a round
 *     this grader has locked, POST .../unblind writes
 *     `unblind-request.json` (the grader's name and the time) into the
 *     round directory. The producer watches for it, unblinds with its
 *     key, and writes `results.json` back: per-arm scores, or an
 *     `error`. Babelr reads results.json only for a grader who has
 *     locked, so nobody still grading sees a score. (With several
 *     graders the files are `unblind-request.<grader>.json` and
 *     `results.<grader>.json`, like the ratings.) That is a check, not a
 *     guarantee: a hand-written ratings.json with locked_at passes it,
 *     and key.json is readable on disk by anyone with file access.
 *
 * blind.json (written by robokohl/blinds.py `export`):
 *   {
 *     round: string,
 *     title: string,
 *     prompts: [{ id, text }],
 *     answers: [{ label, prompt_id, text }],     // labels opaque, e.g. P1-A
 *     rubric:  [{ id, label, type: 'bool'|'scale', min?, max?, help? }],
 *     rank?:   boolean,                           // rank answers per prompt
 *     graders?: string[]                          // local usernames; default BLINDS_GRADER
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
  /** As written in blind.json; empty means BLINDS_GRADER decides. */
  graders: string[];
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
  /** Present once this grader has locked. */
  unblind?: BlindUnblind;
}

/** One arm's scores, as the producer computed them from the key. */
export interface ArmScores {
  answers: number;
  /** Per rubric field: bool → {yes, rated}; scale → {mean, rated}. */
  fields: Record<string, { yes?: number; mean?: number | null; rated: number }>;
  mean_rank?: number;
}

/** What the producer writes back after unblinding. */
export interface BlindResults {
  unblindedAt: string | null;
  arms: Record<string, ArmScores>;
  error: string | null;
}

export interface BlindUnblind {
  requested: boolean;
  results: BlindResults | null;
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
/** Babelr's own username rule (routes/auth.ts), so it's also safe in a filename. */
const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;
const GRADER_RATINGS_RE = /^ratings\.[a-zA-Z0-9_]{3,32}\.json$/;
/** The unblind handshake: Babelr writes the request, reads the results. */
export const REQUEST_FILE = 'unblind-request.json';
export const RESULTS_FILE = 'results.json';
const GRADER_REQUEST_RE = /^unblind-request\.[a-zA-Z0-9_]{3,32}\.json$/;
const GRADER_RESULTS_RE = /^results\.[a-zA-Z0-9_]{3,32}\.json$/;
const MAX_RESULTS_BYTES = 256 * 1024;
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

/** BLINDS_GRADER as a list. Unset or empty means nobody. */
export function envGraders(): string[] {
  return (process.env.BLINDS_GRADER ?? '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
}

/** Who grades this round: its own list, else BLINDS_GRADER. */
export function gradersFor(bundle: BlindBundle): string[] {
  return bundle.graders.length ? bundle.graders : envGraders();
}

/** The export a grader's lock writes: ratings.json for a lone grader. */
export function ratingsFileFor(bundle: BlindBundle, grader: string): string {
  return gradersFor(bundle).length === 1 ? RATINGS_FILE : `ratings.${grader}.json`;
}

/** This grader's unblind request and results files, named like the ratings. */
export function unblindFilesFor(bundle: BlindBundle, grader: string) {
  const alone = gradersFor(bundle).length === 1;
  return {
    request: alone ? REQUEST_FILE : `unblind-request.${grader}.json`,
    results: alone ? RESULTS_FILE : `results.${grader}.json`,
  };
}

/**
 * Resolve a file inside a round's bundle directory. This is the only
 * path builder the plugin uses, and it only ever hands out blind.json
 * (for reading) or a ratings export (ratings.json or
 * ratings.<grader>.json, for the lock). Anything else — key.json,
 * raw.json, '../x' — throws.
 */
export function bundleFile(round: string, name: string, mode: 'read' | 'write'): string {
  const ok =
    mode === 'read'
      ? name === BUNDLE_FILE || name === RESULTS_FILE || GRADER_RESULTS_RE.test(name)
      : name === RATINGS_FILE ||
        GRADER_RATINGS_RE.test(name) ||
        name === REQUEST_FILE ||
        GRADER_REQUEST_RE.test(name);
  if (!ok) {
    const allowed =
      mode === 'read'
        ? `${BUNDLE_FILE} or ${RESULTS_FILE}`
        : `${RATINGS_FILE} or ${REQUEST_FILE} (or their per-grader forms)`;
    throw new BundleError(`refusing to ${mode} ${name}: only ${allowed} is allowed`, 400);
  }
  if (!isValidRound(round)) throw new BundleError('invalid round name', 400);
  const root = resolve(blindsDir());
  const p = resolve(root, round, name);
  if (!p.startsWith(root + sep)) throw new BundleError('invalid round path', 400);
  return p;
}

function str(v: unknown, what: string, max = 100_000): string {
  if (typeof v !== 'string' || v.length > max)
    throw new BundleError(`${what} must be a string`, 422);
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
  if (r.round !== round)
    throw new BundleError('blind.json round does not match its directory', 422);
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
    if (!promptIds.has(prompt_id))
      throw new BundleError(`answers[${i}] has unknown prompt_id`, 422);
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
      if (
        !Number.isInteger(min) ||
        !Number.isInteger(max) ||
        (min as number) >= (max as number) ||
        (max as number) - (min as number) > 10
      ) {
        throw new BundleError(`rubric[${i}] scale needs integer min < max (span <= 10)`, 422);
      }
      return {
        id,
        label,
        type: 'scale',
        min: min as number,
        max: max as number,
        ...(help ? { help } : {}),
      };
    }
    throw new BundleError(`rubric[${i}].type must be bool or scale`, 422);
  });
  if (rubric.length === 0) throw new BundleError('rubric is empty', 422);
  if (new Set(rubric.map((f) => f.id)).size !== rubric.length)
    throw new BundleError('duplicate rubric id', 422);

  let graders: string[] = [];
  if (r.graders !== undefined) {
    if (
      !Array.isArray(r.graders) ||
      !r.graders.every((g) => typeof g === 'string' && USERNAME_RE.test(g))
    ) {
      throw new BundleError('graders must be a list of local usernames', 422);
    }
    graders = [...new Set(r.graders as string[])];
  }

  return {
    round,
    title: typeof r.title === 'string' ? r.title.slice(0, 500) : round,
    prompts,
    answers,
    rubric,
    rank: r.rank === true,
    graders,
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

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Validate a parsed results.json, copying out only numbers and names. */
export function sanitizeResults(raw: unknown): BlindResults {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (typeof r.error === 'string') {
    return { unblindedAt: null, arms: {}, error: r.error.slice(0, 500) };
  }
  const armsIn = (r.arms && typeof r.arms === 'object' ? r.arms : {}) as Record<string, unknown>;
  const arms: Record<string, ArmScores> = {};
  for (const [name, a] of Object.entries(armsIn).slice(0, 50)) {
    if (!a || typeof a !== 'object' || name.length > 64) continue;
    const row = a as Record<string, unknown>;
    const fields: ArmScores['fields'] = {};
    const fin = (row.fields && typeof row.fields === 'object' ? row.fields : {}) as Record<
      string,
      unknown
    >;
    for (const [id, v] of Object.entries(fin).slice(0, 50)) {
      if (!ID_RE.test(id) || !v || typeof v !== 'object') continue;
      const f = v as Record<string, unknown>;
      fields[id] = {
        rated: num(f.rated) ?? 0,
        ...(num(f.yes) !== undefined ? { yes: num(f.yes) } : {}),
        ...('mean' in f ? { mean: num(f.mean) ?? null } : {}),
      };
    }
    arms[name] = {
      answers: num(row.answers) ?? 0,
      fields,
      ...(num(row.mean_rank) !== undefined ? { mean_rank: num(row.mean_rank) } : {}),
    };
  }
  const at = typeof r.unblinded_at === 'string' ? r.unblinded_at.slice(0, 64) : null;
  return { unblindedAt: at, arms, error: null };
}

/** This round's results file, if the producer has written one. */
export async function loadResults(round: string, name: string): Promise<BlindResults | null> {
  const p = bundleFile(round, name, 'read');
  let st;
  try {
    st = await lstat(p);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > MAX_RESULTS_BYTES) {
    return { unblindedAt: null, arms: {}, error: `${name} is not a readable results file` };
  }
  const fh = await open(p, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    return sanitizeResults(JSON.parse(await fh.readFile('utf8')));
  } catch {
    return { unblindedAt: null, arms: {}, error: `${name} is not valid JSON` };
  } finally {
    await fh.close();
  }
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
  if (
    !Number.isInteger(value) ||
    (value as number) < field.min! ||
    (value as number) > field.max!
  ) {
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
  const out: Record<
    string,
    { prompt_id: string; fields: Record<string, RatingValue>; note: string }
  > = {};
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
  version: '0.2.0',
  description:
    'Grade blind eval answers one at a time; each grader alone. [[blind:<round>]] embeds.',
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
    {
      // Per-grader ratings. The grader column defaults to '' so the
      // ALTERs work on any existing rows; before this migration a round
      // could only be graded by BLINDS_GRADER, and on 2026-10-28 that was
      // unset on the one live Tower, so there were none.
      id: 2,
      name: 'per-grader',
      up: `
        ALTER TABLE plugin_blinds_rounds ADD COLUMN IF NOT EXISTS grader TEXT NOT NULL DEFAULT '';
        UPDATE plugin_blinds_rounds SET grader = locked_by WHERE locked_by IS NOT NULL;
        ALTER TABLE plugin_blinds_rounds DROP CONSTRAINT IF EXISTS plugin_blinds_rounds_pkey;
        ALTER TABLE plugin_blinds_rounds ADD PRIMARY KEY (round, grader);

        ALTER TABLE plugin_blinds_ratings ADD COLUMN IF NOT EXISTS grader TEXT NOT NULL DEFAULT '';
        ALTER TABLE plugin_blinds_ratings DROP CONSTRAINT IF EXISTS plugin_blinds_ratings_pkey;
        ALTER TABLE plugin_blinds_ratings ADD PRIMARY KEY (round, grader, label);

        ALTER TABLE plugin_blinds_ranks ADD COLUMN IF NOT EXISTS grader TEXT NOT NULL DEFAULT '';
        ALTER TABLE plugin_blinds_ranks DROP CONSTRAINT IF EXISTS plugin_blinds_ranks_pkey;
        ALTER TABLE plugin_blinds_ranks ADD PRIMARY KEY (round, grader, prompt_id);
      `,
    },
  ],

  serverRoutes: async (fastify) => {
    // Gate every route on a signed-in local account. Which rounds you
    // grade is decided per round (gradeable), and a round you don't
    // grade 404s exactly like a missing one, so nobody else can learn
    // whether it exists.
    fastify.addHook('onRequest', async (request, reply) => {
      const a = request.actor;
      if (!a || a.local !== true) {
        return reply.status(403).send({ error: 'Blinds are visible to their graders only' });
      }
      reply.header('Cache-Control', 'no-store');
    });

    function me(request: { actor?: { preferredUsername: string } | null }): string {
      return request.actor!.preferredUsername;
    }

    /** The bundle, if `grader` grades it; otherwise the missing-round 404. */
    async function gradeable(round: string, grader: string): Promise<BlindBundle> {
      const bundle = await loadBundle(round);
      if (!gradersFor(bundle).includes(grader)) throw new BundleError('round not found', 404);
      return bundle;
    }

    function fail(
      reply: { status: (n: number) => { send: (b: unknown) => unknown } },
      err: unknown,
    ) {
      if (err instanceof BundleError) return reply.status(err.status).send({ error: err.message });
      throw err;
    }

    type Tx = { execute: (q: SQL) => PromiseLike<unknown> };

    async function lockedAt(round: string, grader: string): Promise<string | null> {
      const rows = (await fastify.db.execute(
        sql`SELECT round, locked_at FROM plugin_blinds_rounds
          WHERE round = ${round} AND grader = ${grader}`,
      )) as unknown as RoundRow[];
      return iso(rows[0]?.locked_at ?? null);
    }

    async function loadRatings(
      round: string,
      grader: string,
      db: Tx = fastify.db,
    ): Promise<Record<string, AnswerRating>> {
      const rows = (await db.execute(
        sql`SELECT label, fields, note FROM plugin_blinds_ratings
          WHERE round = ${round} AND grader = ${grader}`,
      )) as unknown as RatingRow[];
      const out: Record<string, AnswerRating> = {};
      for (const r of rows) out[r.label] = { fields: jsonCol(r.fields), note: r.note };
      return out;
    }

    async function loadRanks(
      round: string,
      grader: string,
      db: Tx = fastify.db,
    ): Promise<Record<string, string[]>> {
      const rows = (await db.execute(
        sql`SELECT prompt_id, ordering FROM plugin_blinds_ranks
          WHERE round = ${round} AND grader = ${grader}`,
      )) as unknown as RankRow[];
      const out: Record<string, string[]> = {};
      for (const r of rows) out[r.prompt_id] = jsonCol(r.ordering);
      return out;
    }

    async function payload(round: string, grader: string): Promise<BlindRoundPayload> {
      const bundle = await gradeable(round, grader);
      const all = await loadRatings(round, grader);
      const ratings: Record<string, AnswerRating> = {};
      for (const a of bundle.answers) if (all[a.label]) ratings[a.label] = all[a.label];
      const locked = await lockedAt(round, grader);
      return {
        bundle,
        ratings,
        ranks: bundle.rank ? await loadRanks(round, grader) : {},
        lockedAt: locked,
        graded: bundle.answers.filter((a) => isGraded(bundle, ratings[a.label])).length,
        total: bundle.answers.length,
        // Scores exist only for a grader who has locked: never read the
        // results file for anyone still grading.
        ...(locked ? { unblind: await unblindState(bundle, round, grader) } : {}),
      };
    }

    async function unblindState(
      bundle: BlindBundle,
      round: string,
      grader: string,
    ): Promise<BlindUnblind> {
      const files = unblindFilesFor(bundle, grader);
      let requested = true;
      try {
        await lstat(bundleFile(round, files.request, 'write'));
      } catch {
        requested = false;
      }
      return { requested, results: await loadResults(round, files.results) };
    }

    /**
     * Run a write in a transaction that holds this grader's round row
     * FOR UPDATE and checks locked_at under that lock. The lock route takes the
     * same row lock, so a write either commits before the lock's
     * export reads the ratings (and is in ratings.json) or waits and
     * then sees locked_at (409). No write can land after the export.
     */
    async function withRoundLock<T>(
      round: string,
      grader: string,
      fn: (tx: Tx) => PromiseLike<T>,
    ): Promise<T> {
      return fastify.db.transaction(async (tx: Tx) => {
        await tx.execute(
          sql`INSERT INTO plugin_blinds_rounds (round, grader) VALUES (${round}, ${grader})
            ON CONFLICT (round, grader) DO NOTHING`,
        );
        const rows = (await tx.execute(
          sql`SELECT round, locked_at FROM plugin_blinds_rounds
            WHERE round = ${round} AND grader = ${grader} FOR UPDATE`,
        )) as unknown as RoundRow[];
        if (rows[0]?.locked_at) throw new BundleError('Round is locked', 409);
        return fn(tx);
      });
    }

    fastify.get('/rounds', async (request) => {
      const out: BlindRoundSummary[] = [];
      for (const round of await listRoundDirs()) {
        try {
          const p = await payload(round, me(request));
          out.push({
            round,
            title: p.bundle.title,
            graded: p.graded,
            total: p.total,
            lockedAt: p.lockedAt,
          });
        } catch {
          // not yours, or malformed — skip; GET /rounds/:round reports why
        }
      }
      return out;
    });

    fastify.get<{ Params: { round: string } }>('/rounds/:round', async (request, reply) => {
      try {
        return await payload(request.params.round, me(request));
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
        const grader = me(request);
        const bundle = await gradeable(round, grader);
        if (!bundle.answers.some((a) => a.label === label))
          throw new BundleError('unknown answer label', 404);
        const body = request.body ?? {};
        const hasField = typeof body.field === 'string';
        const hasNote = body.note !== undefined;
        if (hasField === hasNote)
          throw new BundleError('send exactly one of {field, value} or {note}', 400);
        if (hasField) {
          const field = bundle.rubric.find((f) => f.id === body.field);
          if (!field) throw new BundleError('unknown rubric field', 400);
          if (body.value === undefined)
            throw new BundleError('value is required (null clears)', 400);
          const v = checkValue(field, body.value);
          if (v === null) {
            await withRoundLock(round, grader, (tx) =>
              tx.execute(
                sql`UPDATE plugin_blinds_ratings SET fields = fields - ${field.id}, updated_at = NOW()
                  WHERE round = ${round} AND grader = ${grader} AND label = ${label}`,
              ),
            );
          } else {
            const patch = JSON.stringify({ [field.id]: v });
            await withRoundLock(round, grader, (tx) =>
              tx.execute(
                sql`INSERT INTO plugin_blinds_ratings (round, grader, label, fields)
                  VALUES (${round}, ${grader}, ${label}, ${patch}::jsonb)
                  ON CONFLICT (round, grader, label) DO UPDATE
                  SET fields = plugin_blinds_ratings.fields || EXCLUDED.fields, updated_at = NOW()`,
              ),
            );
          }
        } else {
          if (typeof body.note !== 'string' || body.note.length > MAX_NOTE) {
            throw new BundleError(`note must be a string up to ${MAX_NOTE} chars`, 400);
          }
          await withRoundLock(round, grader, (tx) =>
            tx.execute(
              sql`INSERT INTO plugin_blinds_ratings (round, grader, label, note)
                VALUES (${round}, ${grader}, ${label}, ${body.note})
                ON CONFLICT (round, grader, label) DO UPDATE
                SET note = EXCLUDED.note, updated_at = NOW()`,
            ),
          );
        }
        const ratings = await loadRatings(round, grader);
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
          const grader = me(request);
          const bundle = await gradeable(round, grader);
          if (!bundle.rank) throw new BundleError('this round has no rank step', 400);
          if (!bundle.prompts.some((p) => p.id === promptId))
            throw new BundleError('unknown prompt', 404);
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
          await withRoundLock(round, grader, (tx) =>
            tx.execute(
              sql`INSERT INTO plugin_blinds_ranks (round, grader, prompt_id, ordering)
                VALUES (${round}, ${grader}, ${promptId}, ${JSON.stringify(order)}::jsonb)
                ON CONFLICT (round, grader, prompt_id) DO UPDATE
                SET ordering = EXCLUDED.ordering, updated_at = NOW()`,
            ),
          );
          return { promptId, order };
        } catch (err) {
          return fail(reply, err);
        }
      },
    );

    // Ask the producer to unblind this grader's locked ratings. Writes
    // the request file and nothing else; asking twice is fine.
    fastify.post<{ Params: { round: string } }>(
      '/rounds/:round/unblind',
      async (request, reply) => {
        try {
          const { round } = request.params;
          const grader = me(request);
          const bundle = await gradeable(round, grader);
          if (!(await lockedAt(round, grader))) {
            throw new BundleError('Lock the round first: unblinding comes after grading', 409);
          }
          const target = bundleFile(round, unblindFilesFor(bundle, grader).request, 'write');
          try {
            const fh = await open(
              target,
              fsConstants.O_WRONLY |
                fsConstants.O_CREAT |
                fsConstants.O_EXCL |
                fsConstants.O_NOFOLLOW,
              0o600,
            );
            try {
              const doc = { round, grader, requested_at: new Date().toISOString() };
              await fh.writeFile(JSON.stringify(doc, null, 2) + '\n', 'utf8');
            } finally {
              await fh.close();
            }
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
          }
          return await unblindState(bundle, round, grader);
        } catch (err) {
          return fail(reply, err);
        }
      },
    );

    // Freeze the round for this grader and export their ratings. The DB lock and the
    // file write share a transaction: if the file can't be written
    // (including because one already exists) the lock rolls back, and
    // if the transaction fails after the file was created (say, at
    // COMMIT), the file is deleted so a retry can succeed.
    fastify.post<{ Params: { round: string } }>('/rounds/:round/lock', async (request, reply) => {
      try {
        const { round } = request.params;
        const grader = me(request);
        const bundle = await gradeable(round, grader);
        const file = ratingsFileFor(bundle, grader);
        const target = bundleFile(round, file, 'write');
        let created = false;
        let lockedIso: string;
        try {
          lockedIso = await withRoundLock(round, grader, async (tx) => {
            const rows = (await tx.execute(
              sql`UPDATE plugin_blinds_rounds SET locked_at = NOW(), locked_by = ${grader}
                WHERE round = ${round} AND grader = ${grader}
                RETURNING round, locked_at`,
            )) as unknown as RoundRow[];
            const at = iso(rows[0].locked_at)!;
            const ratings = await loadRatings(round, grader, tx);
            const ranks = await loadRanks(round, grader, tx);
            const doc = buildRatingsExport(bundle, ratings, ranks, at, grader);
            let fh;
            try {
              // 'wx' semantics: never overwrite an existing ratings.json.
              fh = await open(
                target,
                fsConstants.O_WRONLY |
                  fsConstants.O_CREAT |
                  fsConstants.O_EXCL |
                  fsConstants.O_NOFOLLOW,
                0o600,
              );
              created = true;
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
                throw new BundleError(`${file} already exists; refusing to overwrite`, 409);
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
        } catch (err) {
          if (created) await unlink(target).catch(() => {});
          throw err;
        }
        return { round, lockedAt: lockedIso, file };
      } catch (err) {
        return fail(reply, err);
      }
    });
  },

  // Deliberately no federationHandlers: a remote Tower must never be
  // able to resolve a round. setupClient lives in client-entry.ts.
});
