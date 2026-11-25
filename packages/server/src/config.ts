// SPDX-License-Identifier: MIT

/**
 * Federation policy mode:
 * - 'open': accept activities from any instance (default)
 * - 'allowlist': only accept from domains in the allowlist
 * - 'blocklist': accept from all except domains in the blocklist
 */
export type FederationMode = 'open' | 'allowlist' | 'blocklist';

/**
 * Who may create an account (REGISTRATION):
 * - 'open': anyone who can reach the server (the default, as before)
 * - 'invite': only someone holding a valid server invite code
 * - 'closed': nobody
 * In every mode the first person on an empty instance may register
 * (someone has to be able to make the first invite), and agent and
 * service accounts made by a sponsor are unaffected.
 */
export type RegistrationMode = 'open' | 'invite' | 'closed';

const REGISTRATION_MODES: readonly RegistrationMode[] = ['open', 'invite', 'closed'];

/** Parse REGISTRATION. Unset means 'open'; anything unrecognised is a
 *  startup error, never a silent fall back to open. */
export function parseRegistrationMode(raw: string | undefined): RegistrationMode {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return 'open';
  if ((REGISTRATION_MODES as readonly string[]).includes(value)) return value as RegistrationMode;
  throw new Error(`REGISTRATION must be one of ${REGISTRATION_MODES.join(', ')} (got "${raw}")`);
}

/**
 * Parse TRUST_PROXY into Fastify's `trustProxy` option. Unset keeps the
 * old behaviour (trust every hop in production, none otherwise).
 * 'true'/'false', a hop count, or proxy-addr names/addresses such as
 * 'loopback' or '127.0.0.1,::1'.
 */
export function parseTrustProxy(
  raw: string | undefined,
  isProduction: boolean,
): boolean | number | string {
  const value = (raw ?? '').trim();
  if (!value) return isProduction;
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  return value;
}

/** Parse PUBLIC_URL (the origin people's browsers use, e.g. a tunnel's
 *  https URL) into a bare origin with no trailing slash. */
export function parsePublicUrl(raw: string | undefined): string | undefined {
  const value = (raw ?? '').trim();
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `PUBLIC_URL must be an absolute URL like https://chat.example.com (got "${raw}")`,
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`PUBLIC_URL must be http(s) (got "${raw}")`);
  }
  return url.origin;
}

export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  domain: string;
  sessionSecret: string;
  /** Production mode: https actor URIs and always-Secure cookies. It
   *  also picks the protocol of every ActivityPub id, so it is not the
   *  switch for "served over https through a tunnel"; see publicUrl. */
  secureCookies: boolean;
  /** Who may create an account. */
  registration: RegistrationMode;
  /** The origin browsers reach this instance at, when that isn't
   *  BABELR_DOMAIN (a tunnel or reverse proxy). Used for links people
   *  open (invite links, email links), never for federation ids. */
  publicUrl?: string;
  /** Fastify `trustProxy`: whose X-Forwarded-* headers to believe. */
  trustProxy: boolean | number | string;
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
    registration: parseRegistrationMode(process.env.REGISTRATION),
    publicUrl: parsePublicUrl(process.env.PUBLIC_URL),
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY, process.env.NODE_ENV === 'production'),
    federationMode: (process.env.FEDERATION_MODE as FederationMode) ?? 'open',
    federationDomains: process.env.FEDERATION_DOMAINS
      ? process.env.FEDERATION_DOMAINS.split(',')
          .map((d) => d.trim().toLowerCase())
          .filter(Boolean)
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
