// SPDX-License-Identifier: Hippocratic-3.0
import { describe, it, expect } from 'vitest';
import { generateActorKeypair } from '../../federation/keys.ts';

describe('RSA Key Generation', () => {
  it('generates a valid RSA keypair', () => {
    const { publicKeyPem, privateKeyPem } = generateActorKeypair();

    expect(publicKeyPem).toContain('-----BEGIN PUBLIC KEY-----');
    expect(publicKeyPem).toContain('-----END PUBLIC KEY-----');
    expect(privateKeyPem).toContain('-----BEGIN PRIVATE KEY-----');
    expect(privateKeyPem).toContain('-----END PRIVATE KEY-----');
  });

  it('generates unique keypairs', () => {
    const pair1 = generateActorKeypair();
    const pair2 = generateActorKeypair();

    expect(pair1.publicKeyPem).not.toBe(pair2.publicKeyPem);
    expect(pair1.privateKeyPem).not.toBe(pair2.privateKeyPem);
  });
});
