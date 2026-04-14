// SPDX-License-Identifier: Hippocratic-3.0

/**
 * Federation policy mode:
 * - 'open': accept activities from any instance (default)
 * - 'allowlist': only accept from domains in the allowlist
 * - 'blocklist': accept from all except domains in the blocklist
 */
export type FederationMode = 'open' | 'allowlist' | 'blocklist';

export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  domain: string;
  sessionSecret: string;
  secureCookies: boolean;
  /** Federation access control mode. */
  federationMode: FederationMode;
  /** Comma-separated domain list for allowlist/blocklist mode. */
  federationDomains: string[];
  /** OIDC SSO configuration. All fields required to enable OIDC. */
  oidcIssuer?: string;
  oidcClientId?: string;
  oidcClientSecret?: string;
  oidcRedirectUri?: string;
  /** Bind address for mediasoup RTC sockets (UDP/TCP for DTLS+RTP). */
  mediasoupListenIp: string;
  /** Public IP advertised in ICE candidates. Required behind NAT. */
  mediasoupAnnouncedIp?: string;
  mediasoupRtcMinPort: number;
  mediasoupRtcMaxPort: number;
}

export function loadConfig(): Config {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    throw new Error('SESSION_SECRET environment variable is required');
  }

  return {
    port: parseInt(process.env.PORT ?? '3000', 10),
    host: process.env.HOST ?? '0.0.0.0',
    databaseUrl,
    domain: process.env.BABELR_DOMAIN ?? 'localhost:3000',
    sessionSecret,
    secureCookies: process.env.NODE_ENV === 'production',
    federationMode: (process.env.FEDERATION_MODE as FederationMode) ?? 'open',
    federationDomains: process.env.FEDERATION_DOMAINS
      ? process.env.FEDERATION_DOMAINS.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean)
      : [],
    oidcIssuer: process.env.OIDC_ISSUER || undefined,
    oidcClientId: process.env.OIDC_CLIENT_ID || undefined,
    oidcClientSecret: process.env.OIDC_CLIENT_SECRET || undefined,
    oidcRedirectUri: process.env.OIDC_REDIRECT_URI || undefined,
    mediasoupListenIp:
      process.env.MEDIASOUP_LISTEN_IP ??
      (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
    mediasoupAnnouncedIp: process.env.MEDIASOUP_ANNOUNCED_IP || undefined,
    mediasoupRtcMinPort: parseInt(process.env.MEDIASOUP_RTC_MIN_PORT ?? '40000', 10),
    mediasoupRtcMaxPort: parseInt(process.env.MEDIASOUP_RTC_MAX_PORT ?? '40099', 10),
  };
}
