// SPDX-License-Identifier: MIT
/**
 * DM encryption for plugins, outside React: the same key pair and the same
 * ECDH + AES-GCM the chat view uses (useE2E), handed to plugins through
 * PluginClientApi.dm. A 1:1 DM's key is shared with the other participant
 * whoever wrote the message, so one partner id decrypts both sides.
 */
import { importPublicKeyJWK, deriveSharedKey } from './keys';
import { encryptMessage } from './encrypt';
import { decryptMessage } from './decrypt';
import { loadKeyPair } from './store';
import * as api from '../api';

const shared = new Map<string, Promise<CryptoKey | null>>();

function keyFor(partnerId: string): Promise<CryptoKey | null> {
  let k = shared.get(partnerId);
  if (!k) {
    k = (async () => {
      const pair = await loadKeyPair();
      if (!pair) return null;
      const { publicKey } = await api.getUserPublicKey(partnerId);
      if (!publicKey) return null;
      return deriveSharedKey(pair.privateKey, await importPublicKeyJWK(publicKey));
    })().catch(() => null);
    k.then((v) => {
      if (!v) shared.delete(partnerId); // try again next time, keys may arrive
    });
    shared.set(partnerId, k);
  }
  return k;
}

export const pluginDM = {
  /** Plaintext, or null when it can't be read (no key, or not ours). */
  async decrypt(content: string, iv: string, partnerId: string): Promise<string | null> {
    const key = await keyFor(partnerId);
    if (!key) return null;
    try {
      return await decryptMessage(content, iv, key);
    } catch {
      return null;
    }
  },
  /** The body to POST to /dms/:id/messages; throws when it can't encrypt. */
  async encrypt(
    plaintext: string,
    partnerId: string,
  ): Promise<{ content: string; properties: { encrypted: true; iv: string } }> {
    const key = await keyFor(partnerId);
    if (!key) throw new Error("can't encrypt: no key for this DM yet (open it once in Babelr)");
    const { ciphertext, iv } = await encryptMessage(plaintext, key);
    return { content: ciphertext, properties: { encrypted: true, iv } };
  },
};
