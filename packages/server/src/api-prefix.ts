// SPDX-License-Identifier: Hippocratic-3.0

/**
 * The web client calls `/api/...`. In development Vite's proxy strips the
 * prefix; when the server serves the built client itself, nothing did, so
 * every call 404'd (login included). The server strips it too.
 */
export function stripApiPrefix(url: string): string {
  if (url !== '/api' && !url.startsWith('/api/') && !url.startsWith('/api?')) return url;
  const rest = url.slice(4);
  return rest.startsWith('/') ? rest : `/${rest}`;
}
