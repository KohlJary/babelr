// SPDX-License-Identifier: Hippocratic-3.0

/**
 * Generator and helpers for short message slugs. Used by the server
 * when creating a Note row and by any future client-side paths that
 * need to mint an identifier ahead of time.
 *
 * Slug shape: 10 characters from a 31-char Crockford-inspired
 * alphabet (no 0/O, no 1/l/i — less confusion when reading aloud or
 * copy-pasting). 31^10 ≈ 8.2×10^14 possible values; at any realistic
 * message volume the collision probability is negligible. The
 * server still wraps writes in a partial unique index so a freak
 * collision would be caught at insert time.
 *
 * The alphabet deliberately matches the SQL backfill in migration
 * 0012_previous_kylun.sql so existing messages and new messages
 * draw from the same pool.
 */

export const MESSAGE_SLUG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const MESSAGE_SLUG_LENGTH = 10;

const ALPHABET_LEN = MESSAGE_SLUG_ALPHABET.length;

/**
 * Generate a fresh message slug. Uses `crypto.getRandomValues` for
 * the random bytes so the result is cryptographically random even
 * though the collision-resistance requirement here is much weaker
 * than that. Works identically in Node 18+ and in browsers.
 */
export function generateMessageSlug(): string {
  const bytes = new Uint8Array(MESSAGE_SLUG_LENGTH);
  // globalThis.crypto is available in Node 18+ and all modern browsers.
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < MESSAGE_SLUG_LENGTH; i++) {
    out += MESSAGE_SLUG_ALPHABET[bytes[i] % ALPHABET_LEN];
  }
  return out;
}

const SLUG_RE = new RegExp(`^[${MESSAGE_SLUG_ALPHABET}]{${MESSAGE_SLUG_LENGTH}}$`);

/**
 * Validate a message slug. Checks length and alphabet. Doesn't
 * check existence — that's a DB lookup.
 */
export function isValidMessageSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && SLUG_RE.test(slug);
}

/**
 * Generic short slug helpers. Messages and events both use the
 * same 10-char Crockford-ish format, so the two namespaces share
 * this pool. Future slugged entity types (e.g. attachments if we
 * ever promote them) can reuse the same generator.
 *
 * The `Message` aliases are kept as historical names so existing
 * call sites don't need to churn.
 */
export const generateShortSlug = generateMessageSlug;
export const isValidShortSlug = isValidMessageSlug;
export const generateEventSlug = generateMessageSlug;
export const isValidEventSlug = isValidMessageSlug;
