// SPDX-License-Identifier: MIT
// The client publishes this browser's key only when the account has none on the server.
import { describe, expect, it, vi } from 'vitest';
import { publishIfMissing } from '../../../client/src/hooks/publishKey';

const key = {} as CryptoKey;
const jwk = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } as JsonWebKey;

function deps(onServer: JsonWebKey | null) {
  return {
    getMe: vi.fn(async () => ({ id: 'me' })),
    getUserPublicKey: vi.fn(async () => ({ publicKey: onServer })),
    setPublicKey: vi.fn(async () => {}),
    exportJwk: vi.fn(async () => jwk),
  };
}

describe('publishIfMissing', () => {
  it('publishes when the server has no key for this account', async () => {
    const d = deps(null);
    expect(await publishIfMissing(key, d)).toBe(true);
    expect(d.getUserPublicKey).toHaveBeenCalledWith('me');
    expect(d.setPublicKey).toHaveBeenCalledWith(jwk);
  });

  it('never replaces a key that is there (another device may hold it)', async () => {
    const d = deps({ kty: 'EC', crv: 'P-256', x: 'other', y: 'other' });
    expect(await publishIfMissing(key, d)).toBe(false);
    expect(d.setPublicKey).not.toHaveBeenCalled();
  });
});
