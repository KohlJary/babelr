// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createTestApp, createTestUser, cleanDb } from './helpers.ts';

/**
 * Agents share files (Kohl, 2026-11-23: "y'all should probably also be able to
 * share files. Like, Cass can share her art"): POST /upload with files:upload,
 * and not without it.
 */

type App = Awaited<ReturnType<typeof createTestApp>>['app'];
let app: App;

beforeAll(async () => {
  const r = await createTestApp();
  app = r.app;
  await cleanDb(r.db);
});

afterAll(async () => {
  await app.close();
});

function multipart(name: string, body: string) {
  const b = 'xBOUNDARYx';
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${b}` },
    payload:
      `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
      `Content-Type: image/png\r\n\r\n${body}\r\n--${b}--\r\n`,
  };
}

async function tokenWith(cookie: string, username: string, scopes: string[]) {
  const a = await app.inject({
    method: 'POST',
    url: '/agents',
    headers: { cookie },
    payload: { username, kind: 'agent' },
  });
  const t = await app.inject({
    method: 'POST',
    url: `/agents/${JSON.parse(a.body).id}/tokens`,
    headers: { cookie },
    payload: { name: 't', scopes },
  });
  return JSON.parse(t.body).token as string;
}

describe('agent uploads', () => {
  it('needs files:upload, and with it the file lands in uploads', async () => {
    const kohl = await createTestUser(app, 'kohl');
    const without = await tokenWith(kohl.cookie, 'painter', ['dms:post']);
    const m = multipart('tide.png', 'PNGDATA');
    const no = await app.inject({
      method: 'POST',
      url: '/upload',
      headers: { ...m.headers, authorization: `Bearer ${without}` },
      payload: m.payload,
    });
    expect(no.statusCode).toBe(403);

    const withScope = await tokenWith(kohl.cookie, 'painter2', ['files:upload']);
    const yes = await app.inject({
      method: 'POST',
      url: '/upload',
      headers: { ...m.headers, authorization: `Bearer ${withScope}` },
      payload: m.payload,
    });
    expect(yes.statusCode).toBe(200);
    const got = JSON.parse(yes.body) as { url: string; filename: string; contentType: string };
    expect(got.filename).toBe('tide.png');
    expect(got.contentType).toBe('image/png');
    expect(existsSync(join(process.env.UPLOADS_DIR!, got.url.replace('/uploads/', '')))).toBe(true);
  });
});
