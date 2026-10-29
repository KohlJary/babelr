// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash, createSign } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  createFederationTestApp,
  createTestUser,
  createRemoteActor,
  postToInbox,
  cleanDb,
  testConfig,
} from './helpers.ts';
import { wsSent } from '../helpers.ts';
import { actors } from '../../db/schema/actors.ts';
import { collectionItems } from '../../db/schema/collections.ts';

/**
 * Inbox hardening, from Momus's review of PR #4:
 *
 *   - Signatures: the Digest must match the body received, the Date
 *     must be within 5 minutes, and the signature must cover
 *     (request-target), host, date and digest. Before this, a 1-day-old
 *     Date and a Digest of a different body were both accepted.
 *   - Project-management WorkItem activities: a federated actor may
 *     write only to boards of a server it belongs to, and may update or
 *     delete only items it reported. Before this, an unrelated remote
 *     actor retitled and deleted a local task with 202s.
 */

type App = Awaited<ReturnType<typeof createFederationTestApp>>['app'];
type Db = Awaited<ReturnType<typeof createFederationTestApp>>['db'];
type Remote = Awaited<ReturnType<typeof createRemoteActor>>;

let app: App;
let db: Db;
let alice: { id: string; cookie: string };
let serverId: string;
let boardId: string;
let boardSlug: string;
let columnId: string;
let aliceTaskSlug: string;
let zed: Remote; // remote member of alice's server
let yan: Remote; // remote, not a member

const HOST = testConfig.domain;
const digestOf = (body: string) => `SHA-256=${createHash('sha256').update(body).digest('base64')}`;

/** Sign by hand, so a test can pick the header list, Date and Digest. */
function sign(
  signer: Remote,
  opts: { path: string; headers: string; date?: string; digest?: string; method?: string },
): string {
  const values: Record<string, string> = {
    '(request-target)': `${(opts.method ?? 'POST').toLowerCase()} ${opts.path}`,
    host: HOST,
    date: opts.date ?? '',
    digest: opts.digest ?? '',
  };
  const str = opts.headers
    .split(' ')
    .map((h) => `${h}: ${values[h]}`)
    .join('\n');
  const signature = createSign('sha256').update(str).sign(signer.privateKeyPem, 'base64');
  return `keyId="${signer.actor.uri}#main-key",algorithm="rsa-sha256",headers="${opts.headers}",signature="${signature}"`;
}

async function postRaw(
  signer: Remote,
  activity: Record<string, unknown>,
  opts: { date?: string; signedDigestOf?: string; headers?: string; omitDate?: boolean } = {},
) {
  const body = JSON.stringify(activity);
  const date = opts.date ?? new Date().toUTCString();
  const digest = digestOf(opts.signedDigestOf ?? body);
  const signature = sign(signer, {
    path: '/inbox',
    headers: opts.headers ?? '(request-target) host date digest',
    date,
    digest,
  });
  const headers: Record<string, string> = {
    'content-type': 'application/activity+json',
    host: HOST,
    digest,
    signature,
  };
  if (!opts.omitDate) headers.date = date;
  return app.inject({ method: 'POST', url: '/inbox', payload: body, headers });
}

const send = (signer: Remote, activity: Record<string, unknown>) =>
  postToInbox(app, '/inbox', activity, signer.actor.uri, signer.privateKeyPem);

function workItem(signer: Remote, type: 'Create' | 'Update', slug: string, title: string) {
  return {
    id: `${signer.actor.uri}/activities/${Math.random().toString(36).slice(2)}`,
    type,
    actor: signer.actor.uri,
    object: {
      id: `${signer.actor.uri}/items/${slug}`,
      type: ['Note', 'WorkItem'],
      content: title,
      'babelr:slug': slug,
      'babelr:boardId': boardId,
      'babelr:columnId': columnId,
    },
  };
}

function deleteItem(signer: Remote, slug: string) {
  return {
    id: `${signer.actor.uri}/activities/${Math.random().toString(36).slice(2)}`,
    type: 'Delete',
    actor: signer.actor.uri,
    object: `http://${HOST}/plugins/project-management/tasks/${slug}`,
  };
}

async function item(slug: string) {
  const rows = (await db.execute(
    sql`SELECT title, reporter_id FROM plugin_pm_work_items WHERE slug = ${slug}`,
  )) as unknown as { title: string; reporter_id: string }[];
  return rows[0];
}

beforeAll(async () => {
  ({ app, db } = await createFederationTestApp({ plugins: true }));
  await cleanDb(db);
  await db.execute(sql`TRUNCATE plugin_pm_work_items, plugin_pm_columns, plugin_pm_boards CASCADE`);
  const a = await createTestUser(app, 'alice');
  const [aliceRow] = await db.select().from(actors).where(eq(actors.preferredUsername, 'alice'));
  alice = { id: aliceRow.id, cookie: a.cookie };

  const server = await app.inject({
    method: 'POST',
    url: '/servers',
    headers: { cookie: alice.cookie },
    payload: { name: 'Alice House' },
  });
  serverId = JSON.parse(server.body).id;

  const board = await app.inject({
    method: 'POST',
    url: '/plugins/project-management/boards',
    headers: { cookie: alice.cookie },
    payload: { serverId, name: 'Roadmap' },
  });
  expect(board.statusCode).toBe(200);
  boardSlug = JSON.parse(board.body).slug;
  columnId = JSON.parse(board.body).columns[0].id;
  const [row] = (await db.execute(
    sql`SELECT id FROM plugin_pm_boards WHERE slug = ${boardSlug}`,
  )) as unknown as { id: string }[];
  boardId = row.id;

  const task = await app.inject({
    method: 'POST',
    url: `/plugins/project-management/boards/${boardSlug}/work-items`,
    headers: { cookie: alice.cookie },
    payload: { columnId, title: 'ORIGINAL' },
  });
  aliceTaskSlug = JSON.parse(task.body).slug;

  zed = await createRemoteActor(db, { username: 'zed', domain: 'remote.example' });
  yan = await createRemoteActor(db, { username: 'yan', domain: 'remote.example' });
  const [group] = await db.select().from(actors).where(eq(actors.id, serverId));
  await db
    .insert(collectionItems)
    .values({ collectionUri: group.followersUri!, itemUri: zed.actor.uri });
});

afterAll(async () => {
  await app.close();
});

describe('inbox signature checks', () => {
  const ping = () => ({
    id: `${zed.actor.uri}/activities/${Math.random().toString(36).slice(2)}`,
    type: 'Like',
    actor: zed.actor.uri,
    object: `http://${HOST}/nothing`,
  });

  it('accepts what our own signRequest produces', async () => {
    expect((await send(zed, ping())).statusCode).toBe(202);
    expect((await postRaw(zed, ping())).statusCode).toBe(202);
  });

  it('rejects a Digest that does not match the body', async () => {
    const res = await postRaw(zed, ping(), { signedDigestOf: 'some other body' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a Date more than 5 minutes off, either way', async () => {
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000).toUTCString();
    expect((await postRaw(zed, ping(), { date: old })).statusCode).toBe(401);
    const ahead = new Date(Date.now() + 10 * 60 * 1000).toUTCString();
    expect((await postRaw(zed, ping(), { date: ahead })).statusCode).toBe(401);
  });

  it('rejects a request with no Date header', async () => {
    expect((await postRaw(zed, ping(), { omitDate: true })).statusCode).toBe(401);
  });

  it('rejects a signature made for another Tower', async () => {
    const activity = ping();
    const body = JSON.stringify(activity);
    const date = new Date().toUTCString();
    const digest = digestOf(body);
    const target = '(request-target): post /inbox';
    for (const host of ['evil.example', `${HOST}:4444`]) {
      const str = [target, `host: ${host}`, `date: ${date}`, `digest: ${digest}`].join('\n');
      const sig = createSign('sha256').update(str).sign(zed.privateKeyPem, 'base64');
      const res = await app.inject({
        method: 'POST',
        url: '/inbox',
        payload: body,
        headers: {
          'content-type': 'application/activity+json',
          host,
          date,
          digest,
          signature: `keyId="${zed.actor.uri}#main-key",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="${sig}"`,
        },
      });
      expect(res.statusCode, host).toBe(401);
    }
  });

  it('rejects a signature that leaves out date or digest', async () => {
    for (const headers of ['(request-target) host digest', '(request-target) host date']) {
      expect((await postRaw(zed, ping(), { headers })).statusCode, headers).toBe(401);
    }
  });
});

describe('WorkItem activities from federated actors', () => {
  it("ignore a non-member's update and delete", async () => {
    expect((await send(yan, workItem(yan, 'Update', aliceTaskSlug, 'HIJACKED'))).statusCode).toBe(
      202,
    );
    expect((await item(aliceTaskSlug)).title).toBe('ORIGINAL');
    await send(yan, deleteItem(yan, aliceTaskSlug));
    expect(await item(aliceTaskSlug)).toBeDefined();
  });

  it("ignore a member's update or delete of an item they did not report", async () => {
    await send(zed, workItem(zed, 'Update', aliceTaskSlug, 'HIJACKED'));
    expect((await item(aliceTaskSlug)).title).toBe('ORIGINAL');
    await send(zed, deleteItem(zed, aliceTaskSlug));
    expect(await item(aliceTaskSlug)).toBeDefined();
  });

  it("never let a Create overwrite someone else's item", async () => {
    await send(zed, workItem(zed, 'Create', aliceTaskSlug, 'HIJACKED'));
    const row = await item(aliceTaskSlug);
    expect(row.title).toBe('ORIGINAL');
    expect(row.reporter_id).toBe(alice.id);
  });

  it("ignore a non-member's create", async () => {
    await send(yan, workItem(yan, 'Create', 'yanitem001', 'from yan'));
    expect(await item('yanitem001')).toBeUndefined();
  });

  it("let a member create, update and delete their own item, telling only the server's members", async () => {
    wsSent.length = 0;
    await send(zed, workItem(zed, 'Create', 'zeditem001', 'from zed'));
    expect((await item('zeditem001')).reporter_id).toBe(zed.actor.id);
    // The handler's broadcast is fire-and-forget; wait for it.
    await vi.waitFor(() => expect(wsSent.length).toBeGreaterThan(0));
    // alice is the only local member; nothing goes to every socket.
    expect(new Set(wsSent.map((w) => w.to))).toEqual(new Set([alice.id]));

    await send(zed, workItem(zed, 'Update', 'zeditem001', 'zed, renamed'));
    expect((await item('zeditem001')).title).toBe('zed, renamed');
    await send(zed, deleteItem(zed, 'zeditem001'));
    expect(await item('zeditem001')).toBeUndefined();
  });
});
