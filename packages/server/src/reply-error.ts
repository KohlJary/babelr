// SPDX-License-Identifier: Hippocratic-3.0
import type { FastifyReply } from 'fastify';

/**
 * Consistent error response shape. Replaces the scattered
 * `reply.status(4xx).send({ error: '...' })` pattern with a
 * single-call helper that enforces the { error } envelope.
 *
 * Usage:
 *   return replyError(reply, 400, 'Bad input');
 *   return replyError(reply, 404, 'Not found');
 */
export function replyError(
  reply: FastifyReply,
  status: number,
  message: string,
) {
  return reply.status(status).send({ error: message });
}
