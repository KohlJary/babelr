// SPDX-License-Identifier: Hippocratic-3.0
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp, createTestUser, cleanDb } from '../helpers.ts';
import type Fastify from 'fastify';
import type { createDb } from '../../db/index.ts';
import { isValidShortSlug } from '@babelr/shared';

let app: ReturnType<typeof Fastify>;
let db: ReturnType<typeof createDb>;

beforeAll(async () => {
  const result = await createTestApp();
  app = result.app;
  db = result.db;
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await cleanDb(db);
});

async function createServer(username: string) {
  const user = await createTestUser(app, username);
  const serverRes = await app.inject({
    method: 'POST',
    url: '/servers',
    headers: { cookie: user.cookie },
    payload: { name: `${username}_s` },
  });
  const server = JSON.parse(serverRes.body);
  return { user, serverId: server.id };
}

function makeFilePayload(filename = 'test.txt', content = 'hello') {
  const boundary = '---TestBoundary';
  const body = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    'Content-Type: text/plain',
    '',
    content,
    `--${boundary}--`,
  ].join('\r\n');
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

describe('File upload + slug generation', () => {
  it('assigns a slug to every uploaded file', async () => {
    const { user, serverId } = await createServer('file_slug');
    const { body, contentType } = makeFilePayload();
    const res = await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/files`,
      headers: { cookie: user.cookie, 'content-type': contentType },
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    const file = JSON.parse(res.body);
    expect(file.slug).toBeTruthy();
    expect(isValidShortSlug(file.slug)).toBe(true);
    expect(file.filename).toBe('test.txt');
    expect(file.sizeBytes).toBe(5);
  });
});

describe('File CRUD', () => {
  it('lists files for a server', async () => {
    const { user, serverId } = await createServer('file_list');
    const { body, contentType } = makeFilePayload();
    await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/files`,
      headers: { cookie: user.cookie, 'content-type': contentType },
      payload: body,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/servers/${serverId}/files`,
      headers: { cookie: user.cookie },
    });
    expect(res.statusCode).toBe(200);
    const { files } = JSON.parse(res.body);
    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe('test.txt');
  });

  it('updates file metadata', async () => {
    const { user, serverId } = await createServer('file_update');
    const { body, contentType } = makeFilePayload();
    const createRes = await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/files`,
      headers: { cookie: user.cookie, 'content-type': contentType },
      payload: body,
    });
    const file = JSON.parse(createRes.body);

    const updateRes = await app.inject({
      method: 'PUT',
      url: `/servers/${serverId}/files/${file.id}`,
      headers: { cookie: user.cookie },
      payload: { title: 'Updated Title', description: 'A description', tags: ['docs'] },
    });
    expect(updateRes.statusCode).toBe(200);
    const updated = JSON.parse(updateRes.body);
    expect(updated.title).toBe('Updated Title');
    expect(updated.description).toBe('A description');
    expect(updated.tags).toEqual(['docs']);
  });

  it('deletes a file', async () => {
    const { user, serverId } = await createServer('file_delete');
    const { body, contentType } = makeFilePayload();
    const createRes = await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/files`,
      headers: { cookie: user.cookie, 'content-type': contentType },
      payload: body,
    });
    const file = JSON.parse(createRes.body);

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/servers/${serverId}/files/${file.id}`,
      headers: { cookie: user.cookie },
    });
    expect(delRes.statusCode).toBe(200);

    const listRes = await app.inject({
      method: 'GET',
      url: `/servers/${serverId}/files`,
      headers: { cookie: user.cookie },
    });
    expect(JSON.parse(listRes.body).files).toHaveLength(0);
  });
});

describe('GET /files/by-slug/:slug', () => {
  it('returns the file embed for a valid slug', async () => {
    const { user, serverId } = await createServer('file_embed');
    const { body, contentType } = makeFilePayload('readme.md', '# Hello');
    const createRes = await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/files`,
      headers: { cookie: user.cookie, 'content-type': contentType },
      payload: body,
    });
    const file = JSON.parse(createRes.body);

    const res = await app.inject({
      method: 'GET',
      url: `/files/by-slug/${file.slug}`,
      headers: { cookie: user.cookie },
    });
    expect(res.statusCode).toBe(200);
    const embed = JSON.parse(res.body);
    expect(embed.slug).toBe(file.slug);
    expect(embed.filename).toBe('readme.md');
    expect(embed.sizeBytes).toBe(7);
  });

  it('returns 404 for nonexistent slug', async () => {
    const user = await createTestUser(app, 'file_missing');
    const res = await app.inject({
      method: 'GET',
      url: '/files/by-slug/zzzzzzzzzz',
      headers: { cookie: user.cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('File chat collection', () => {
  it('creates a chat collection on upload', async () => {
    const { user, serverId } = await createServer('file_chat');
    const { body, contentType } = makeFilePayload();
    const createRes = await app.inject({
      method: 'POST',
      url: `/servers/${serverId}/files`,
      headers: { cookie: user.cookie, 'content-type': contentType },
      payload: body,
    });
    const file = JSON.parse(createRes.body);
    expect(file.chatId).toBeTruthy();
  });
});

describe('wiki-links parser — file refs', () => {
  it('parses [[file:slug]] as file-kind refs', async () => {
    const { parseWikiRefs, extractFileSlugs } = await import('@babelr/shared');
    const src = 'Check out [[file:abcdefghjk]] for details.';
    const refs = parseWikiRefs(src);
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe('file');
    expect(refs[0].slug).toBe('abcdefghjk');
    expect(extractFileSlugs(src)).toEqual(['abcdefghjk']);
  });

  it('distinguishes file, event, message, and page refs', async () => {
    const { parseWikiRefs } = await import('@babelr/shared');
    const src = '[[page]], [[msg:aaaaaaaaaa]], [[event:bbbbbbbbbb]], [[file:cccccccccc]]';
    const refs = parseWikiRefs(src);
    expect(refs.map((r) => r.kind)).toEqual(['page', 'message', 'event', 'file']);
  });
});
