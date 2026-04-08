// SPDX-License-Identifier: Hippocratic-3.0
import { describe, it, expect } from 'vitest';
import { generateActorKeypair } from '../../federation/keys.ts';
import {
  signRequest,
  verifySignatureFromParts,
  createDigest,
  getKeyIdFromSignature,
} from '../../federation/signatures.ts';

describe('HTTP Signatures', () => {
  const { publicKeyPem, privateKeyPem } = generateActorKeypair();
  const keyId = 'https://test.babelr.local/users/alice#main-key';

  it('creates a SHA-256 digest', () => {
    const digest = createDigest('hello world');
    expect(digest).toMatch(/^SHA-256=/);
    expect(digest.length).toBeGreaterThan(10);
  });

  it('signs and verifies a POST request', () => {
    const body = JSON.stringify({ type: 'Follow', actor: 'https://remote/users/bob' });
    const url = 'https://test.babelr.local/users/alice/inbox';

    const { headers } = signRequest(privateKeyPem, keyId, 'POST', url, body);

    expect(headers.Signature).toContain('keyId=');
    expect(headers.Signature).toContain('rsa-sha256');
    expect(headers.Date).toBeTruthy();
    expect(headers.Digest).toMatch(/^SHA-256=/);

    const valid = verifySignatureFromParts(
      publicKeyPem,
      headers.Signature,
      'POST',
      '/users/alice/inbox',
      {
        host: 'test.babelr.local',
        date: headers.Date,
        digest: headers.Digest,
      },
    );

    expect(valid).toBe(true);
  });

  it('rejects a tampered body', () => {
    const body = JSON.stringify({ type: 'Follow' });
    const url = 'https://test.babelr.local/users/alice/inbox';

    const { headers } = signRequest(privateKeyPem, keyId, 'POST', url, body);

    // Verify with a different digest (tampered body)
    const valid = verifySignatureFromParts(
      publicKeyPem,
      headers.Signature,
      'POST',
      '/users/alice/inbox',
      {
        host: 'test.babelr.local',
        date: headers.Date,
        digest: createDigest('tampered body'),
      },
    );

    expect(valid).toBe(false);
  });

  it('rejects a wrong public key', () => {
    const otherKey = generateActorKeypair();
    const body = '{}';
    const url = 'https://test.babelr.local/users/alice/inbox';

    const { headers } = signRequest(privateKeyPem, keyId, 'POST', url, body);

    const valid = verifySignatureFromParts(
      otherKey.publicKeyPem,
      headers.Signature,
      'POST',
      '/users/alice/inbox',
      {
        host: 'test.babelr.local',
        date: headers.Date,
        digest: headers.Digest,
      },
    );

    expect(valid).toBe(false);
  });

  it('extracts keyId from signature header', () => {
    const body = '{}';
    const url = 'https://test.babelr.local/users/alice/inbox';
    const { headers } = signRequest(privateKeyPem, keyId, 'POST', url, body);

    const extracted = getKeyIdFromSignature(headers.Signature);
    expect(extracted).toBe(keyId);
  });
});
