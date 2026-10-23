// SPDX-License-Identifier: Hippocratic-3.0
import type { actors } from './db/schema/actors.ts';

/**
 * Message `properties` used to be stored exactly as the client sent
 * them, so any client could write `provenance.author = "kohl"`, mark
 * plaintext as `encrypted`, or attach an arbitrary off-site URL.
 *
 * Now the server keeps only the keys clients legitimately send, checks
 * their shape, and stamps who wrote the message itself. Provenance is
 * the server's word, from the authenticated actor row, never the
 * client's.
 *
 * Posts are data, not instructions: nothing here (or anywhere on the
 * server) reads message content or properties as a command.
 */

/** Keys only the server may set. Client values are dropped. */
export const SERVER_PROVENANCE_KEYS = ['authorKind', 'sponsor'] as const;

const MAX_ATTACHMENTS = 10;
const UPLOAD_URL_RE =
  /^\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[^/\\?#]{0,32}$/;
const IV_RE = /^[A-Za-z0-9+/]{16}$/; // 12-byte AES-GCM IV, base64

export interface Attachment {
  url: string;
  filename: string;
  contentType: string;
}

function cleanAttachment(raw: unknown): Attachment | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  // Only files uploaded to this Tower (/upload names them <uuid>.<ext>).
  if (typeof a.url !== 'string' || !UPLOAD_URL_RE.test(a.url) || a.url.includes('..')) {
    return null;
  }
  const filename = typeof a.filename === 'string' ? a.filename.slice(0, 256) : 'file';
  const contentType =
    typeof a.contentType === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(a.contentType)
      ? a.contentType
      : 'application/octet-stream';
  return { url: a.url, filename, contentType };
}

/**
 * Keep what clients may send: `encrypted` + a well-formed `iv` (both
 * or neither) and attachments that point at this Tower's uploads.
 * Everything else, including any provenance-looking key, is dropped.
 */
export function sanitizeClientProperties(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const p = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  if (p.encrypted === true && typeof p.iv === 'string' && IV_RE.test(p.iv)) {
    out.encrypted = true;
    out.iv = p.iv;
  }

  if (Array.isArray(p.attachments)) {
    const atts = p.attachments
      .slice(0, MAX_ATTACHMENTS)
      .map(cleanAttachment)
      .filter((a): a is Attachment => a !== null);
    if (atts.length > 0) out.attachments = atts;
  }

  return out;
}

/** The server-stamped provenance for a message by `actor`. */
export async function provenanceFor(
  actor: typeof actors.$inferSelect,
  lookupSponsor: (id: string) => Promise<{ id: string; preferredUsername: string } | null>,
): Promise<Record<string, unknown>> {
  const kind = actor.kind === 'agent' || actor.kind === 'service' ? actor.kind : 'person';
  const out: Record<string, unknown> = { authorKind: kind };
  if (kind !== 'person' && actor.sponsorId) {
    const sponsor = await lookupSponsor(actor.sponsorId);
    if (sponsor) out.sponsor = { id: sponsor.id, preferredUsername: sponsor.preferredUsername };
  }
  return out;
}
