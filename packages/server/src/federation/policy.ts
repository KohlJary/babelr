// SPDX-License-Identifier: Hippocratic-3.0
import type { Config } from '../config.ts';

/**
 * Extract the domain from a URI or actor URL.
 * Handles both full URLs (https://example.com/users/alice)
 * and acct: URIs (acct:alice@example.com).
 */
export function extractDomain(uri: string): string | null {
  try {
    if (uri.startsWith('acct:')) {
      const at = uri.indexOf('@');
      return at >= 0 ? uri.slice(at + 1).toLowerCase() : null;
    }
    const url = new URL(uri);
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Check whether a remote domain is allowed to federate with this
 * Tower based on the current federation policy.
 *
 * Returns true if the domain is allowed, false if blocked.
 * Local domains (matching config.domain) are always allowed.
 */
export function isDomainAllowed(config: Config, domain: string): boolean {
  const d = domain.toLowerCase();

  // Always allow our own domain
  const localDomain = config.domain.split(':')[0].toLowerCase();
  if (d === localDomain) return true;

  switch (config.federationMode) {
    case 'open':
      return true;
    case 'allowlist':
      return config.federationDomains.includes(d);
    case 'blocklist':
      return !config.federationDomains.includes(d);
    default:
      return true;
  }
}

/**
 * Check whether an actor URI is allowed to federate.
 * Extracts the domain and delegates to isDomainAllowed.
 */
export function isActorAllowed(config: Config, actorUri: string): boolean {
  const domain = extractDomain(actorUri);
  if (!domain) return false;
  return isDomainAllowed(config, domain);
}
