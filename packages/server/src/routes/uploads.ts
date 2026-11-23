// SPDX-License-Identifier: MIT
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import '../types.ts';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export default async function uploadRoutes(fastify: FastifyInstance) {
  // UPLOADS_DIR overrides (tests point it at a temp dir); made when the route
  // is registered, not at import, so importing this never writes anywhere.
  const UPLOADS_DIR = process.env.UPLOADS_DIR ?? join(process.cwd(), '../../uploads');
  mkdirSync(UPLOADS_DIR, { recursive: true });

  // Upload a file
  fastify.post('/upload', async (request, reply) => {
    if (!request.actor) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ error: 'No file provided' });
    }

    if (data.file.bytesRead > MAX_FILE_SIZE) {
      return reply.status(400).send({ error: 'File too large (max 10MB)' });
    }

    const ext = data.filename.split('.').pop() ?? '';
    const safeName = `${crypto.randomUUID()}.${ext}`;
    const filePath = join(UPLOADS_DIR, safeName);

    await pipeline(data.file, createWriteStream(filePath));

    return {
      url: `/uploads/${safeName}`,
      filename: data.filename,
      contentType: data.mimetype,
    };
  });
}
