// SPDX-License-Identifier: Hippocratic-3.0
import jwt from 'jsonwebtoken';

/**
 * Federated voice JWT. Issued by an origin Tower to a remote actor (via
 * their home Tower) authorizing them to join one specific voice channel
 * for a short window. Signed with the origin Tower's SESSION_SECRET so
 * no new key infrastructure is needed.
 */

export interface VoiceFederationClaims {
  /** Remote actor URI. */
  sub: string;
  /** Channel ID (UUID) the token authorizes joining. */
  channelId: string;
  /** Issuing Tower's domain. */
  iss: string;
  /** Issued at (seconds). */
  iat: number;
  /** Expires at (seconds). */
  exp: number;
}

const TTL_SECONDS = 5 * 60;

export function issueVoiceFederationToken(opts: {
  secret: string;
  actorUri: string;
  channelId: string;
  issuerDomain: string;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: VoiceFederationClaims = {
    sub: opts.actorUri,
    channelId: opts.channelId,
    iss: opts.issuerDomain,
    iat: now,
    exp: now + TTL_SECONDS,
  };
  return jwt.sign(payload, opts.secret, { algorithm: 'HS256' });
}

export function verifyVoiceFederationToken(
  token: string,
  secret: string,
): VoiceFederationClaims | null {
  try {
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
    if (typeof decoded !== 'object' || decoded === null) return null;
    const claims = decoded as VoiceFederationClaims;
    if (typeof claims.sub !== 'string') return null;
    if (typeof claims.channelId !== 'string') return null;
    return claims;
  } catch {
    return null;
  }
}
