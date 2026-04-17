// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyInstance } from 'fastify';
import { eq, and, desc, sql } from 'drizzle-orm';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { writeAuditLog } from '../audit.ts';
import '../types.ts';
import { actors } from '../db/schema/actors.ts';
import { objects } from '../db/schema/objects.ts';
import { serverFiles } from '../db/schema/files.ts';
import { toAuthorView } from '../serializers.ts';
import type {
  FileView,
  FileEmbedView,
} from '@babelr/shared';
import { PERMISSIONS, generateShortSlug, isValidShortSlug } from '@babelr/shared';
import { hasPermission } from '../permissions.ts';
import { enqueueToFollowers, enqueueDelivery } from '../federation/delivery.ts';
import { serializeActivity } from '../federation/jsonld.ts';
import { ensureActorKeys } from '../federation/keys.ts';

function serializeFile(file: typeof serverFiles.$inferSelect) {
  return {
    type: 'Document',
    id: file.storageUrl,
    name: file.title ?? file.filename,
    filename: file.filename,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    storageUrl: file.storageUrl,
    slug: file.slug,
    description: file.description,
    tags: file.tags,
    folderPath: file.folderPath,
  };
}

function toFileView(
  file: typeof serverFiles.$inferSelect,
  uploader: typeof actors.$inferSelect,
): FileView {
  return {
    id: file.id,
    serverId: file.serverId,
    uploader: toAuthorView(uploader),
    filename: file.filename,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    storageUrl: file.storageUrl,
    slug: file.slug,
    title: file.title,
    description: file.description,
    tags: file.tags ?? [],
    folderPath: file.folderPath,
    chatId: file.chatId,
    createdAt: file.createdAt.toISOString(),
    updatedAt: file.updatedAt.toISOString(),
  };
}

export default async function fileRoutes(fastify: FastifyInstance) {
  const db = fastify.db;
  // Resolve uploads dir relative to this source file so it works
  // in both dev (tsx watch from packages/server) and test (vitest
  // from repo root) contexts. In production, use cwd/uploads.
  const isProduction = process.env.NODE_ENV === 'production';
  const uploadsDir = isProduction
    ? join(process.cwd(), 'uploads')
    : join(__dirname, '../../../..', 'uploads');

  // List subfolders at a given path. Returns immediate children only.
  fastify.get<{
    Params: { serverId: string };
    Querystring: { parent?: string };
  }>('/servers/:serverId/folders', async (request, reply) => {
    if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });

    if (!(await hasPermission(db, request.params.serverId, request.actor.id, PERMISSIONS.VIEW_FILES))) {
      return reply.status(403).send({ error: 'Not a member of this server' });
    }

    const parent = request.query.parent?.trim() || null;

    // Get all distinct folder_paths for this server
    const allFiles = await db
      .select({ folderPath: serverFiles.folderPath })
      .from(serverFiles)
      .where(eq(serverFiles.serverId, request.params.serverId));

    // Collect all unique folder paths (including intermediate ones)
    const allFolders = new Set<string>();
    for (const f of allFiles) {
      if (!f.folderPath) continue;
      const parts = f.folderPath.split('/');
      for (let i = 1; i <= parts.length; i++) {
        allFolders.add(parts.slice(0, i).join('/'));
      }
    }

    // Filter to immediate children of the parent
    const children: string[] = [];
    for (const folder of allFolders) {
      if (parent === null) {
        // Root level: folders with no slash
        if (!folder.includes('/')) children.push(folder);
      } else {
        // Subfolders: must start with parent/ and have exactly one more segment
        const prefix = parent + '/';
        if (folder.startsWith(prefix) && !folder.slice(prefix.length).includes('/')) {
          children.push(folder);
        }
      }
    }

    return { folders: children.sort() };
  });

  // List files for a server
  fastify.get<{
    Params: { serverId: string };
    Querystring: { folder?: string; tag?: string; contentType?: string };
  }>('/servers/:serverId/files', async (request, reply) => {
    if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });

    if (!(await hasPermission(db, request.params.serverId, request.actor.id, PERMISSIONS.VIEW_FILES))) {
      return reply.status(403).send({ error: 'Not a member of this server' });
    }

    // For remote servers, sync files from the origin.
    const [serverActor] = await db.select().from(actors).where(eq(actors.id, request.params.serverId)).limit(1);
    if (serverActor && !serverActor.local) {
      try {
        const origin = new URL(serverActor.uri).origin;
        const slug = serverActor.preferredUsername;
        const filesUrl = `${origin}/groups/${encodeURIComponent(slug)}/files`;
        const res = await fetch(filesUrl, {
          headers: { Accept: 'application/json', 'User-Agent': 'Babelr/0.1.0' },
          signal: AbortSignal.timeout(5_000),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            files: Array<{
              storageUrl: string; filename: string; contentType: string;
              sizeBytes: number; slug: string | null; title: string | null;
              description: string | null; tags: string[]; folderPath: string | null;
            }>;
          };
          for (const f of data.files ?? []) {
            const [existing] = await db.select({ id: serverFiles.id }).from(serverFiles)
              .where(eq(serverFiles.storageUrl, f.storageUrl)).limit(1);
            if (existing) {
              await db.update(serverFiles).set({
                title: f.title, description: f.description, tags: f.tags,
                folderPath: f.folderPath, updatedAt: new Date(),
              }).where(eq(serverFiles.id, existing.id));
            } else {
              const chatUri = `${new URL(serverActor.uri).protocol}//${new URL(serverActor.uri).host}/files/${crypto.randomUUID()}/chat`;
              const [chatChannel] = await db.insert(objects).values({
                uri: chatUri, type: 'OrderedCollection', belongsTo: null,
                properties: { name: f.filename, isFileChat: true },
              }).returning();
              await db.insert(serverFiles).values({
                serverId: serverActor.id, uploaderId: serverActor.id,
                filename: f.filename, contentType: f.contentType,
                sizeBytes: f.sizeBytes, storageUrl: f.storageUrl,
                slug: f.slug ?? generateShortSlug(),
                title: f.title, description: f.description,
                tags: f.tags, folderPath: f.folderPath,
                chatId: chatChannel.id,
              }).onConflictDoNothing();
            }
          }
        }
      } catch { /* Non-fatal */ }
    }

    const conditions = [eq(serverFiles.serverId, request.params.serverId)];
    if (request.query.folder !== undefined) {
      const folder = request.query.folder || null;
      if (folder === null) {
        conditions.push(sql`${serverFiles.folderPath} IS NULL`);
      } else {
        conditions.push(eq(serverFiles.folderPath, folder));
      }
    }

    const files = await db
      .select({ file: serverFiles, uploader: actors })
      .from(serverFiles)
      .innerJoin(actors, eq(serverFiles.uploaderId, actors.id))
      .where(and(...conditions))
      .orderBy(desc(serverFiles.createdAt));

    // Filter by tag/contentType in memory (simpler than SQL array ops)
    let results = files;
    if (request.query.tag) {
      const tag = request.query.tag.toLowerCase();
      results = results.filter((r) => r.file.tags?.some((t) => t.toLowerCase() === tag));
    }
    if (request.query.contentType) {
      const ct = request.query.contentType.toLowerCase();
      results = results.filter((r) => r.file.contentType.toLowerCase().startsWith(ct));
    }

    return {
      files: results.map((r) => toFileView(r.file, r.uploader)),
    };
  });

  // Upload a file
  fastify.post<{ Params: { serverId: string } }>(
    '/servers/:serverId/files',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });

      if (!(await hasPermission(db, request.params.serverId, request.actor.id, PERMISSIONS.UPLOAD_FILES))) {
        return reply.status(403).send({ error: 'Insufficient permissions' });
      }

      let data;
      try {
        data = await request.file();
      } catch (err) {
        fastify.log.error({ err }, 'Multipart parse failed');
        return reply.status(400).send({ error: 'Failed to parse upload' });
      }
      if (!data) return reply.status(400).send({ error: 'No file uploaded' });

      const filename = data.filename;
      const contentType = data.mimetype;
      const buffer = await data.toBuffer();
      const sizeBytes = buffer.length;

      // Save to uploads directory
      if (!existsSync(uploadsDir)) await mkdir(uploadsDir, { recursive: true });
      const storageFilename = `${crypto.randomUUID()}${filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : ''}`;
      const storagePath = join(uploadsDir, storageFilename);
      await writeFile(storagePath, buffer);

      const storageUrl = `/uploads/${storageFilename}`;

      // Extract optional metadata from multipart fields. The
      // fields object shape varies: when no extra fields are sent,
      // it only contains the `file` entry. Guard against missing
      // fields gracefully.
      const fields = (data.fields ?? {}) as Record<string, { value?: string } | undefined>;
      const title = fields.title?.value?.trim() || null;
      const description = fields.description?.value?.trim() || null;
      const folderPath = fields.folderPath?.value?.trim() || null;
      const tagsRaw = fields.tags?.value?.trim();
      const tags = tagsRaw ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean) : [];

      // Create the comment-thread collection (same pattern as event chat)
      const cfg = fastify.config;
      const proto = cfg.secureCookies ? 'https' : 'http';
      const fileId = crypto.randomUUID();
      const chatUri = `${proto}://${cfg.domain}/files/${fileId}/chat`;
      const [chatChannel] = await db
        .insert(objects)
        .values({
          uri: chatUri,
          type: 'OrderedCollection',
          belongsTo: null,
          properties: { name: filename, isFileChat: true, fileId },
        })
        .returning();

      // Generate slug with retry loop
      let created: typeof serverFiles.$inferSelect | undefined;
      let slugAttempts = 0;
      while (!created) {
        slugAttempts++;
        try {
          const [row] = await db
            .insert(serverFiles)
            .values({
              id: fileId,
              serverId: request.params.serverId,
              uploaderId: request.actor.id,
              filename,
              contentType,
              sizeBytes,
              storageUrl,
              slug: generateShortSlug(),
              title,
              description,
              tags,
              folderPath,
              chatId: chatChannel.id,
            })
            .returning();
          created = row;
        } catch (err) {
          const pgErr = err as { code?: string };
          if (pgErr.code === '23505' && slugAttempts <= 5) continue;
          throw err;
        }
      }

      // Federation: deliver Create(Document) to Group followers.
      if (request.actor.local) {
        const [group] = await db.select().from(actors).where(eq(actors.id, request.params.serverId)).limit(1);
        if (group) {
          const doc = { ...serializeFile(created), attributedTo: request.actor.uri, context: group.uri };
          const proto = cfg.secureCookies ? 'https' : 'http';
          const actUri = `${proto}://${cfg.domain}/activities/${crypto.randomUUID()}`;
          if (!group.local && group.inboxUri) {
            const act = serializeActivity(actUri, 'Create', request.actor.uri, doc, ['https://www.w3.org/ns/activitystreams#Public'], [group.followersUri ?? '']);
            ensureActorKeys(db, request.actor)
              .then((k) => enqueueDelivery(db, act, group.inboxUri!, k.id))
              .catch((err) => fastify.log.error(err, 'File create remote federation failed'));
          } else {
            const act = serializeActivity(actUri, 'Create', group.uri, doc, ['https://www.w3.org/ns/activitystreams#Public'], [group.followersUri ?? '']);
            ensureActorKeys(db, group)
              .then((k) => enqueueToFollowers(fastify, k, act))
              .catch((err) => fastify.log.error(err, 'File create federation failed'));
          }
        }
      }

      await writeAuditLog(db, {
        serverId: request.params.serverId,
        actorId: request.actor.id,
        category: 'file',
        action: 'file.upload',
        summary: `Uploaded file "${filename}"`,
        details: { fileId: created.id, filename },
      });

      return reply.status(201).send(toFileView(created, request.actor));
    },
  );

  // Get single file
  fastify.get<{ Params: { serverId: string; fileId: string } }>(
    '/servers/:serverId/files/:fileId',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });

      if (!(await hasPermission(db, request.params.serverId, request.actor.id, PERMISSIONS.VIEW_FILES))) {
        return reply.status(403).send({ error: 'Not a member of this server' });
      }

      const [row] = await db
        .select({ file: serverFiles, uploader: actors })
        .from(serverFiles)
        .innerJoin(actors, eq(serverFiles.uploaderId, actors.id))
        .where(and(eq(serverFiles.id, request.params.fileId), eq(serverFiles.serverId, request.params.serverId)))
        .limit(1);

      if (!row) return reply.status(404).send({ error: 'File not found' });

      return toFileView(row.file, row.uploader);
    },
  );

  // Update file metadata
  fastify.put<{
    Params: { serverId: string; fileId: string };
    Body: { title?: string; description?: string | null; tags?: string[]; folderPath?: string | null };
  }>('/servers/:serverId/files/:fileId', async (request, reply) => {
    if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });

    const [file] = await db
      .select()
      .from(serverFiles)
      .where(and(eq(serverFiles.id, request.params.fileId), eq(serverFiles.serverId, request.params.serverId)))
      .limit(1);

    if (!file) return reply.status(404).send({ error: 'File not found' });

    // Allow edit if uploader or has MANAGE_FILES
    const isUploader = file.uploaderId === request.actor.id;
    if (!isUploader) {
      if (!(await hasPermission(db, request.params.serverId, request.actor.id, PERMISSIONS.MANAGE_FILES))) {
        return reply.status(403).send({ error: 'Insufficient permissions' });
      }
    }

    const body = request.body ?? {};
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.title !== undefined) updates.title = body.title?.trim() || null;
    if (body.description !== undefined) updates.description = body.description?.trim() || null;
    if (body.tags !== undefined) updates.tags = body.tags;
    if (body.folderPath !== undefined) updates.folderPath = body.folderPath?.trim() || null;

    const [updated] = await db
      .update(serverFiles)
      .set(updates)
      .where(eq(serverFiles.id, file.id))
      .returning();

    const [uploader] = await db.select().from(actors).where(eq(actors.id, updated.uploaderId)).limit(1);

    // Federation: deliver Update(Document).
    if (request.actor.local) {
      const [group] = await db.select().from(actors).where(eq(actors.id, request.params.serverId)).limit(1);
      if (group) {
        const cfg = fastify.config;
        const proto = cfg.secureCookies ? 'https' : 'http';
        const doc = { ...serializeFile(updated), attributedTo: request.actor.uri, context: group.uri };
        const actUri = `${proto}://${cfg.domain}/activities/${crypto.randomUUID()}`;
        if (!group.local && group.inboxUri) {
          const act = serializeActivity(actUri, 'Update', request.actor.uri, doc, ['https://www.w3.org/ns/activitystreams#Public'], [group.followersUri ?? '']);
          ensureActorKeys(db, request.actor)
            .then((k) => enqueueDelivery(db, act, group.inboxUri!, k.id))
            .catch((err) => fastify.log.error(err, 'File update remote federation failed'));
        } else {
          const act = serializeActivity(actUri, 'Update', group.uri, doc, ['https://www.w3.org/ns/activitystreams#Public'], [group.followersUri ?? '']);
          ensureActorKeys(db, group)
            .then((k) => enqueueToFollowers(fastify, k, act))
            .catch((err) => fastify.log.error(err, 'File update federation failed'));
        }
      }
    }

    return toFileView(updated, uploader!);
  });

  // Delete file
  fastify.delete<{ Params: { serverId: string; fileId: string } }>(
    '/servers/:serverId/files/:fileId',
    async (request, reply) => {
      if (!request.actor) return reply.status(401).send({ error: 'Not authenticated' });

      const [file] = await db
        .select()
        .from(serverFiles)
        .where(and(eq(serverFiles.id, request.params.fileId), eq(serverFiles.serverId, request.params.serverId)))
        .limit(1);

      if (!file) return reply.status(404).send({ error: 'File not found' });

      const isUploader = file.uploaderId === request.actor.id;
      if (!isUploader) {
        if (!(await hasPermission(db, request.params.serverId, request.actor.id, PERMISSIONS.MANAGE_FILES))) {
          return reply.status(403).send({ error: 'Insufficient permissions' });
        }
      }

      // Delete storage file
      try {
        const storagePath = join(uploadsDir, file.storageUrl.replace('/uploads/', ''));
        await unlink(storagePath);
      } catch {
        // Non-fatal — the DB row is the source of truth.
      }

      // Federation: deliver Delete(Document).
      if (request.actor.local) {
        const [group] = await db.select().from(actors).where(eq(actors.id, request.params.serverId)).limit(1);
        if (group) {
          const cfg = fastify.config;
          const proto = cfg.secureCookies ? 'https' : 'http';
          const actUri = `${proto}://${cfg.domain}/activities/${crypto.randomUUID()}`;
          if (!group.local && group.inboxUri) {
            const act = serializeActivity(actUri, 'Delete', request.actor.uri, file.storageUrl, ['https://www.w3.org/ns/activitystreams#Public'], [group.followersUri ?? '']);
            ensureActorKeys(db, request.actor)
              .then((k) => enqueueDelivery(db, act, group.inboxUri!, k.id))
              .catch((err) => fastify.log.error(err, 'File delete remote federation failed'));
          } else {
            const act = serializeActivity(actUri, 'Delete', group.uri, file.storageUrl, ['https://www.w3.org/ns/activitystreams#Public'], [group.followersUri ?? '']);
            ensureActorKeys(db, group)
              .then((k) => enqueueToFollowers(fastify, k, act))
              .catch((err) => fastify.log.error(err, 'File delete federation failed'));
          }
        }
      }

      await db.delete(serverFiles).where(eq(serverFiles.id, file.id));
      // Clean up the chat collection (cascade handles messages)
      await db.delete(objects).where(eq(objects.id, file.chatId));

      await writeAuditLog(db, {
        serverId: request.params.serverId,
        actorId: request.actor.id,
        category: 'file',
        action: 'file.delete',
        summary: `Deleted file`,
        details: { fileId: file.id },
      });

      return { ok: true };
    },
  );

  // Embed lookup by slug
  fastify.get<{ Params: { slug: string } }>(
    '/files/by-slug/:slug',
    async (request, reply) => {
      const { slug } = request.params;
      if (!isValidShortSlug(slug)) {
        return reply.status(400).send({ error: 'Invalid slug format' });
      }

      const [row] = await db
        .select({ file: serverFiles, uploader: actors })
        .from(serverFiles)
        .innerJoin(actors, eq(serverFiles.uploaderId, actors.id))
        .where(eq(serverFiles.slug, slug))
        .limit(1);

      if (!row) return reply.status(404).send({ error: 'File not found' });

      // For authenticated requests, check membership. For
      // unauthenticated (federation proxy), allow public files.
      if (request.actor) {
        if (!(await hasPermission(db, row.file.serverId, request.actor.id, PERMISSIONS.VIEW_FILES))) {
          return reply.status(404).send({ error: 'File not found' });
        }
      }

      // Resolve server name for the embed view
      const [server] = await db.select().from(actors).where(eq(actors.id, row.file.serverId)).limit(1);
      const serverProps = server?.properties as Record<string, unknown> | null;

      const view: FileEmbedView = {
        id: row.file.id,
        slug: row.file.slug!,
        filename: row.file.filename,
        contentType: row.file.contentType,
        sizeBytes: row.file.sizeBytes,
        storageUrl: row.file.storageUrl,
        title: row.file.title,
        description: row.file.description,
        serverId: row.file.serverId,
        serverName:
          (serverProps?.name as string | undefined) ??
          server?.displayName ??
          server?.preferredUsername ??
          null,
        uploader: toAuthorView(row.uploader),
        chatId: row.file.chatId,
      };

      return view;
    },
  );
}
