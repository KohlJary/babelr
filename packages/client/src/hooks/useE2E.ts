// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect, useRef, useCallback } from 'react';
import type { MessageWithAuthor } from '@babelr/shared';
import {
  generateKeyPair,
  exportPublicKeyJWK,
  importPublicKeyJWK,
  deriveSharedKey,
  encryptMessage,
  decryptMessage,
  saveKeyPair,
  loadKeyPair,
} from '../crypto';
import * as api from '../api';

export interface E2EContext {
  ready: boolean;
  encrypt: (plaintext: string, recipientId: string) => Promise<{ ciphertext: string; iv: string }>;
  /** Decrypt one ciphertext shared with `partnerId`; throws on failure. */
  decrypt: (ciphertext: string, iv: string, partnerId: string) => Promise<string>;
  /** `partnerId` is the other side of a 1:1 DM. The key is shared
   *  with them whoever wrote the message, so it's what decrypts our
   *  own messages too. Without it, the author's key is used. */
  decryptMsg: (msg: MessageWithAuthor, partnerId?: string) => Promise<MessageWithAuthor>;
  decryptMsgs: (msgs: MessageWithAuthor[], partnerId?: string) => Promise<MessageWithAuthor[]>;
}

export function useE2E(): E2EContext {
  const [ready, setReady] = useState(false);
  const privateKeyRef = useRef<CryptoKey | null>(null);
  const sharedKeyCache = useRef<Map<string, CryptoKey>>(new Map());
  const publicKeyCache = useRef<Map<string, JsonWebKey>>(new Map());

  // Initialize keypair on mount
  useEffect(() => {
    (async () => {
      try {
        let keyPair = await loadKeyPair();
        if (!keyPair) {
          keyPair = await generateKeyPair();
          await saveKeyPair(keyPair);
          const publicJwk = await exportPublicKeyJWK(keyPair.publicKey);
          await api.setPublicKey(publicJwk);
        }
        privateKeyRef.current = keyPair.privateKey;
        setReady(true);
      } catch (err) {
        console.error('E2E initialization failed:', err);
      }
    })();
  }, []);

  const getSharedKey = useCallback(async (partnerId: string): Promise<CryptoKey | null> => {
    const cached = sharedKeyCache.current.get(partnerId);
    if (cached) return cached;

    if (!privateKeyRef.current) return null;

    // Fetch partner's public key
    let jwk = publicKeyCache.current.get(partnerId);
    if (!jwk) {
      const res = await api.getUserPublicKey(partnerId);
      if (!res.publicKey) return null;
      jwk = res.publicKey;
      publicKeyCache.current.set(partnerId, jwk);
    }

    const partnerKey = await importPublicKeyJWK(jwk);
    const shared = await deriveSharedKey(privateKeyRef.current, partnerKey);
    sharedKeyCache.current.set(partnerId, shared);
    return shared;
  }, []);

  const encrypt = useCallback(
    async (plaintext: string, recipientId: string) => {
      const sharedKey = await getSharedKey(recipientId);
      if (!sharedKey) throw new Error('Cannot encrypt: recipient has no public key');
      return encryptMessage(plaintext, sharedKey);
    },
    [getSharedKey],
  );

  const decrypt = useCallback(
    async (ciphertext: string, iv: string, partnerId: string) => {
      const sharedKey = await getSharedKey(partnerId);
      if (!sharedKey) throw new Error('Cannot decrypt: key unavailable');
      return decryptMessage(ciphertext, iv, sharedKey);
    },
    [getSharedKey],
  );

  const decryptMsg = useCallback(
    async (msg: MessageWithAuthor, partnerId?: string): Promise<MessageWithAuthor> => {
      if (!msg.message.properties?.encrypted) return msg;

      try {
        const sharedKey = await getSharedKey(partnerId || msg.message.authorId);
        if (!sharedKey) {
          return {
            ...msg,
            message: { ...msg.message, content: '[Encrypted — key unavailable]' },
          };
        }

        const plaintext = await decryptMessage(
          msg.message.content,
          msg.message.properties.iv as string,
          sharedKey,
        );

        return {
          ...msg,
          message: { ...msg.message, content: plaintext },
        };
      } catch {
        return {
          ...msg,
          message: { ...msg.message, content: '[Decryption failed]' },
        };
      }
    },
    [getSharedKey],
  );

  const decryptMsgs = useCallback(
    async (msgs: MessageWithAuthor[], partnerId?: string): Promise<MessageWithAuthor[]> => {
      return Promise.all(msgs.map((m) => decryptMsg(m, partnerId)));
    },
    [decryptMsg],
  );

  return { ready, encrypt, decrypt, decryptMsg, decryptMsgs };
}
