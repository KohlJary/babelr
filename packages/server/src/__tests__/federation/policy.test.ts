// SPDX-License-Identifier: Hippocratic-3.0
import { describe, it, expect } from 'vitest';
import { extractDomain, isDomainAllowed, isActorAllowed } from '../../federation/policy.ts';
import type { Config } from '../../config.ts';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 3000,
    host: '0.0.0.0',
    databaseUrl: '',
    domain: 'tower-a.example.com',
    sessionSecret: 'test',
    secureCookies: false,
    federationMode: 'open',
    federationDomains: [],
    mediasoupListenIp: '127.0.0.1',
    mediasoupRtcMinPort: 40000,
    mediasoupRtcMaxPort: 40099,
    ...overrides,
  };
}

describe('extractDomain', () => {
  it('extracts domain from HTTPS URI', () => {
    expect(extractDomain('https://tower-b.example.com/users/alice')).toBe(
      'tower-b.example.com',
    );
  });

  it('extracts domain from HTTP URI', () => {
    expect(extractDomain('http://localhost:3001/groups/test-server')).toBe(
      'localhost',
    );
  });

  it('extracts domain from acct: URI', () => {
    expect(extractDomain('acct:alice@tower-b.example.com')).toBe(
      'tower-b.example.com',
    );
  });

  it('returns null for invalid URI', () => {
    expect(extractDomain('not-a-uri')).toBeNull();
  });

  it('lowercases domain', () => {
    expect(extractDomain('https://Tower-B.Example.COM/users/alice')).toBe(
      'tower-b.example.com',
    );
  });
});

describe('isDomainAllowed', () => {
  describe('open mode', () => {
    const config = makeConfig({ federationMode: 'open' });

    it('allows any domain', () => {
      expect(isDomainAllowed(config, 'evil.example.com')).toBe(true);
      expect(isDomainAllowed(config, 'friend.example.com')).toBe(true);
    });

    it('allows local domain', () => {
      expect(isDomainAllowed(config, 'tower-a.example.com')).toBe(true);
    });
  });

  describe('allowlist mode', () => {
    const config = makeConfig({
      federationMode: 'allowlist',
      federationDomains: ['friend.example.com', 'partner.example.com'],
    });

    it('allows domains on the allowlist', () => {
      expect(isDomainAllowed(config, 'friend.example.com')).toBe(true);
      expect(isDomainAllowed(config, 'partner.example.com')).toBe(true);
    });

    it('blocks domains not on the allowlist', () => {
      expect(isDomainAllowed(config, 'stranger.example.com')).toBe(false);
      expect(isDomainAllowed(config, 'evil.example.com')).toBe(false);
    });

    it('always allows local domain even if not on allowlist', () => {
      expect(isDomainAllowed(config, 'tower-a.example.com')).toBe(true);
    });

    it('is case-insensitive', () => {
      expect(isDomainAllowed(config, 'FRIEND.EXAMPLE.COM')).toBe(true);
    });
  });

  describe('blocklist mode', () => {
    const config = makeConfig({
      federationMode: 'blocklist',
      federationDomains: ['evil.example.com', 'spam.example.com'],
    });

    it('blocks domains on the blocklist', () => {
      expect(isDomainAllowed(config, 'evil.example.com')).toBe(false);
      expect(isDomainAllowed(config, 'spam.example.com')).toBe(false);
    });

    it('allows domains not on the blocklist', () => {
      expect(isDomainAllowed(config, 'friend.example.com')).toBe(true);
      expect(isDomainAllowed(config, 'stranger.example.com')).toBe(true);
    });

    it('always allows local domain even if on blocklist', () => {
      // Edge case — shouldn't happen in practice, but tests the safety check
      const edgeConfig = makeConfig({
        federationMode: 'blocklist',
        federationDomains: ['tower-a.example.com'],
      });
      expect(isDomainAllowed(edgeConfig, 'tower-a.example.com')).toBe(true);
    });

    it('is case-insensitive', () => {
      expect(isDomainAllowed(config, 'EVIL.EXAMPLE.COM')).toBe(false);
    });
  });

  describe('domain with port', () => {
    it('strips port from config domain for local comparison', () => {
      const config = makeConfig({ domain: 'localhost:3000' });
      expect(isDomainAllowed(config, 'localhost')).toBe(true);
    });
  });
});

describe('isActorAllowed', () => {
  const config = makeConfig({
    federationMode: 'allowlist',
    federationDomains: ['allowed.example.com'],
  });

  it('allows actor from allowed domain', () => {
    expect(
      isActorAllowed(config, 'https://allowed.example.com/users/alice'),
    ).toBe(true);
  });

  it('blocks actor from disallowed domain', () => {
    expect(
      isActorAllowed(config, 'https://blocked.example.com/users/bob'),
    ).toBe(false);
  });

  it('allows local actor', () => {
    expect(
      isActorAllowed(config, 'https://tower-a.example.com/users/admin'),
    ).toBe(true);
  });

  it('returns false for unparseable URI', () => {
    expect(isActorAllowed(config, 'garbage')).toBe(false);
  });
});
