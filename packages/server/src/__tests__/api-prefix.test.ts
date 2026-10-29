// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { stripApiPrefix } from '../api-prefix.ts';

// The built client calls /api/...; with no Vite proxy in front, the
// server strips the prefix itself (app.ts rewriteUrl).
describe('stripApiPrefix', () => {
  it('strips /api from API calls', () => {
    expect(stripApiPrefix('/api/auth/me')).toBe('/auth/me');
    expect(stripApiPrefix('/api')).toBe('/');
  });

  it('keeps the query string', () => {
    expect(stripApiPrefix('/api/auth/verify?token=abc')).toBe('/auth/verify?token=abc');
    expect(stripApiPrefix('/api?x=1')).toBe('/?x=1');
  });

  it('leaves other paths alone', () => {
    for (const u of ['/auth/me', '/apiary/x', '/inbox', '/', '/assets/api/x.js']) {
      expect(stripApiPrefix(u)).toBe(u);
    }
  });
});
