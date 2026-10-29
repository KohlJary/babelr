// SPDX-License-Identifier: MIT
import { randomBytes } from 'node:crypto';

/** A fresh, well-formed 12-byte AES-GCM IV (16 base64 chars). */
export const freshIv = () => randomBytes(12).toString('base64');

/** Message properties marking content as E2E-encrypted, with a fresh IV.
 *  DMs refuse anything else; tests don't need real ciphertext, since the
 *  server only checks the marker and the IV's shape. */
export const enc = () => ({ encrypted: true, iv: freshIv() });

/** The same marker in federated Note form. */
export const encNote = () => ({ babelrEncrypted: true, babelrIv: freshIv() });
