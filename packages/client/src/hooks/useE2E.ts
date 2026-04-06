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
  decryptMsg: (msg: MessageWithAuthor) => Promise<MessageWithAuthor>;
  decryptMsgs: (msgs: MessageWithAuthor[]) => Promise<MessageWithAuthor[]>;
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

  const decryptMsg = useCallback(
    async (msg: MessageWithAuthor): Promise<MessageWithAuthor> => {
      if (!msg.message.properties?.encrypted) return msg;

      try {
        const senderId = msg.message.authorId;
        const sharedKey = await getSharedKey(senderId);
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
    async (msgs: MessageWithAuthor[]): Promise<MessageWithAuthor[]> => {
      return Promise.all(msgs.map(decryptMsg));
    },
    [decryptMsg],
  );

  return { ready, encrypt, decryptMsg, decryptMsgs };
}
