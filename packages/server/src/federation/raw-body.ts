// SPDX-License-Identifier: MIT
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import '../types.ts';

/**
 * Keep the exact request body bytes as `request.rawBody`, for routes
 * that verify an HTTP Signature: the signed Digest header is a hash of
 * those bytes, and the parsed JSON can't reproduce them. Call it inside
 * a route plugin's own (encapsulated) context so it applies only there.
 */
export function captureRawBody(fastify: FastifyInstance): void {
  fastify.addHook('preParsing', async (request, _reply, payload) => {
    const limit = request.routeOptions.bodyLimit ?? fastify.initialConfig.bodyLimit ?? 1048576;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of payload) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      size += buf.length;
      if (size > limit) {
        const err = new Error('Request body is too large') as Error & { statusCode: number };
        err.statusCode = 413;
        throw err;
      }
      chunks.push(buf);
    }
    const raw = Buffer.concat(chunks);
    request.rawBody = raw.toString('utf8');
    return Readable.from([raw]);
  });
}
