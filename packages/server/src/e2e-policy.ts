// SPDX-License-Identifier: Hippocratic-3.0
import type { objects } from './db/schema/objects.ts';
import { isDMRow } from './dm-consent.ts';
import { IV_RE } from './message-provenance.ts';

/**
 * Encryption is enforced in DMs (Babelr step 3e): the server refuses
 * plaintext there. A DM message must arrive marked `encrypted` with a
 * well-formed AES-GCM IV, and an edit must bring a fresh IV, since
 * reusing one under the same key breaks AES-GCM.
 *
 * Only DMs. Private group rooms have no group-key scheme yet, so they
 * are left alone until they do.
 *
 * The server can't tell ciphertext from plaintext by looking; what it
 * checks is the client's claim, so a client that lies still sends
 * plaintext. What this stops is the honest fallback: a client (or an
 * agent, or a remote tower) that simply didn't encrypt.
 */

export const DM_NOT_ENCRYPTED = 'DMs must be end-to-end encrypted';
export const DM_EDIT_IV_REUSED = 'An edited DM message needs a fresh IV';

type ChannelRow = typeof objects.$inferSelect;

/** True when `iv` is a well-formed 12-byte base64 AES-GCM IV. */
export function isValidIv(iv: unknown): iv is string {
  return typeof iv === 'string' && IV_RE.test(iv);
}

/** True when sanitized properties carry the encrypted marker and an IV. */
export function isEncryptedProps(props: Record<string, unknown> | null | undefined): boolean {
  return props?.encrypted === true && isValidIv(props.iv);
}

function refuse(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 400 });
}

/**
 * Throw a 400 when `channel` is a DM and `cleanProps` (already through
 * sanitizeClientProperties) isn't encrypted. A no-op elsewhere.
 */
export function requireEncryptedInDM(
  channel: ChannelRow | undefined | null,
  cleanProps: Record<string, unknown>,
) {
  if (!isDMRow(channel)) return;
  if (!isEncryptedProps(cleanProps)) refuse(DM_NOT_ENCRYPTED);
}

/**
 * For an edit in a DM: the new properties must be encrypted and carry
 * an IV different from the one already stored. A no-op elsewhere.
 */
export function requireFreshIvForDMEdit(
  channel: ChannelRow | undefined | null,
  cleanProps: Record<string, unknown>,
  storedProps: Record<string, unknown> | null | undefined,
) {
  if (!isDMRow(channel)) return;
  if (!isEncryptedProps(cleanProps)) refuse(DM_NOT_ENCRYPTED);
  if (cleanProps.iv === storedProps?.iv) refuse(DM_EDIT_IV_REUSED);
}
