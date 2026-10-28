// SPDX-License-Identifier: Hippocratic-3.0
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Blinds through the real app: buildApp() with the real plugin loader
 * (not serverRoutes mounted by hand), against the test DB only.
 * Checks the loader-mounted surface: no by-slug federation route for
 * `blind`, and a real route 404s a non-grader.
 */

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://babelr:babelr@localhost:5432/babelr_test';

let app: Awaited<ReturnType<typeof import('../app.ts').buildApp>>;
let dir: string;
let prevCwd: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'blinds-app-test-'));
  await mkdir(join(dir, 'r1'));
  await writeFile(
    join(dir, 'r1', 'blind.json'),
    JSON.stringify({
      round: 'r1',
      title: 'R1',
      prompts: [{ id: 'P1', text: 'q' }],
      answers: [{ label: 'P1-A', prompt_id: 'P1', text: 'a' }],
      rubric: [{ id: 'x', label: 'x', type: 'bool' }],
    }),
  );
  // Never a live database: pin the app to the test DB.
  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.SESSION_SECRET = 'test-secret-not-for-production';
  process.env.BLINDS_DIR = dir;
  process.env.BLINDS_GRADER = 'kohl';
  // app.ts and routes/uploads.ts resolve uploads/ as cwd/../../uploads
  // at import time, which assumes cwd is packages/server (as `npm run
  // dev:server` has it). Match that while the app module loads.
  prevCwd = process.cwd();
  process.chdir(join(import.meta.dirname, '../..'));
  const { buildApp } = await import('../app.ts');
  app = await buildApp();
  await app.ready();
  process.chdir(prevCwd);
  await app.db.execute(
    sql`TRUNCATE sessions, activities, delivery_queue, collection_items, read_positions, reactions, notification_preferences, invites, server_role_assignments, server_roles, objects, actors CASCADE`,
  );
});

afterAll(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

async function register(username: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      username,
      email: `${username}@test.babelr.local`,
      password: 'test-password-12chars',
    },
  });
  const raw = res.headers['set-cookie'];
  const c = Array.isArray(raw) ? raw[0] : (raw as string);
  return c.split(';')[0];
}

describe('blinds via the real plugin loader', () => {
  it('mounts no by-slug federation route for blind rounds', async () => {
    const grader = await register('kohl');
    for (const headers of [{}, { cookie: grader }]) {
      const res = await app.inject({
        method: 'GET',
        url: '/plugins/blinds/blind/by-slug/r1',
        headers,
      });
      expect([403, 404]).toContain(res.statusCode);
      expect(res.body).not.toContain('P1-A');
    }
  });

  it('404s a non-grader on a real route and serves the grader', async () => {
    const other = await register('mallory');
    const grader = (
      await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'kohl@test.babelr.local', password: 'test-password-12chars' },
      })
    ).headers['set-cookie'];
    const graderCookie = (Array.isArray(grader) ? grader[0] : (grader as string)).split(';')[0];
    const denied = await app.inject({
      method: 'GET',
      url: '/plugins/blinds/rounds/r1',
      headers: { cookie: other },
    });
    expect(denied.statusCode).toBe(404);
    expect(denied.body).not.toContain('P1-A');
    const anon = await app.inject({ method: 'GET', url: '/plugins/blinds/rounds/r1' });
    expect([401, 403]).toContain(anon.statusCode); // the loader's auth answers first
    const ok = await app.inject({
      method: 'GET',
      url: '/plugins/blinds/rounds/r1',
      headers: { cookie: graderCookie },
    });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).total).toBe(1);
  });
});
