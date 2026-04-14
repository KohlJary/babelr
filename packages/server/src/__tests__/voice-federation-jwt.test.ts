// SPDX-License-Identifier: Hippocratic-3.0
import { describe, it, expect } from 'vitest';
import {
  issueVoiceFederationToken,
  verifyVoiceFederationToken,
} from '../voice/federation-jwt.ts';

describe('voice federation JWT', () => {
  const secret = 'test-secret-not-for-production';

  it('issues a token that round-trips', () => {
    const token = issueVoiceFederationToken({
      secret,
      actorUri: 'https://tower-b.example.com/users/alice',
      channelId: '11111111-1111-1111-1111-111111111111',
      issuerDomain: 'tower-a.example.com',
    });
    const claims = verifyVoiceFederationToken(token, secret);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe('https://tower-b.example.com/users/alice');
    expect(claims!.channelId).toBe('11111111-1111-1111-1111-111111111111');
    expect(claims!.iss).toBe('tower-a.example.com');
    expect(claims!.exp - claims!.iat).toBe(300);
  });

  it('rejects tokens signed with the wrong secret', () => {
    const token = issueVoiceFederationToken({
      secret,
      actorUri: 'https://tower-b.example.com/users/alice',
      channelId: '11111111-1111-1111-1111-111111111111',
      issuerDomain: 'tower-a.example.com',
    });
    expect(verifyVoiceFederationToken(token, 'different-secret')).toBeNull();
  });

  it('rejects malformed tokens', () => {
    expect(verifyVoiceFederationToken('not-a-jwt', secret)).toBeNull();
    expect(verifyVoiceFederationToken('', secret)).toBeNull();
    expect(verifyVoiceFederationToken('a.b.c', secret)).toBeNull();
  });

  it('rejects tokens past their expiry', async () => {
    // Issue with TTL in the past by mutating Date.now temporarily.
    const realNow = Date.now;
    try {
      Date.now = () => realNow() - 10 * 60 * 1000; // 10 minutes ago
      const token = issueVoiceFederationToken({
        secret,
        actorUri: 'https://tower-b.example.com/users/alice',
        channelId: '11111111-1111-1111-1111-111111111111',
        issuerDomain: 'tower-a.example.com',
      });
      Date.now = realNow;
      expect(verifyVoiceFederationToken(token, secret)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });
});
