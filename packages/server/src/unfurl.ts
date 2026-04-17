// SPDX-License-Identifier: Hippocratic-3.0

const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/g;
const FETCH_TIMEOUT = 5_000;
const MAX_BODY_SIZE = 256 * 1024;
const MAX_URLS_PER_MESSAGE = 3;

export interface LinkPreview {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
}

const cache = new Map<string, { preview: LinkPreview; expiresAt: number }>();
const CACHE_TTL = 24 * 60 * 60 * 1000;

/**
 * Extract URLs from message content and fetch og:meta for each.
 * Returns up to MAX_URLS_PER_MESSAGE previews. Cached by URL for
 * 24 hours. Skips [[kind:slug]] embed syntax since those have
 * their own renderer.
 */
export async function unfurlLinks(content: string): Promise<LinkPreview[]> {
  const urls = extractUrls(content);
  if (urls.length === 0) return [];

  const previews: LinkPreview[] = [];

  for (const url of urls.slice(0, MAX_URLS_PER_MESSAGE)) {
    try {
      const preview = await fetchPreview(url);
      if (preview && (preview.title || preview.description)) {
        previews.push(preview);
      }
    } catch {
      // Skip failed fetches
    }
  }

  return previews;
}

function extractUrls(content: string): string[] {
  const matches = content.match(URL_REGEX) ?? [];
  return [...new Set(matches)];
}

async function fetchPreview(url: string): Promise<LinkPreview | null> {
  const now = Date.now();
  const cached = cache.get(url);
  if (cached && cached.expiresAt > now) return cached.preview;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Babelr/0.1.0 (link preview)',
        Accept: 'text/html',
      },
      redirect: 'follow',
    });

    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) return null;

    const body = await readLimited(res, MAX_BODY_SIZE);
    const preview = parseOgMeta(url, body);

    cache.set(url, { preview, expiresAt: now + CACHE_TTL });

    // Evict old entries periodically
    if (cache.size > 500) {
      for (const [key, val] of cache) {
        if (val.expiresAt < now) cache.delete(key);
      }
    }

    return preview;
  } finally {
    clearTimeout(timeout);
  }
}

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalBytes += value.length;
    if (totalBytes >= maxBytes) break;
  }

  reader.releaseLock();
  const decoder = new TextDecoder();
  return chunks.map((c) => decoder.decode(c, { stream: true })).join('');
}

function parseOgMeta(url: string, html: string): LinkPreview {
  const getMetaContent = (property: string): string | null => {
    const patterns = [
      new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, 'i'),
      new RegExp(`<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${property}["']`, 'i'),
    ];
    for (const re of patterns) {
      const match = html.match(re);
      if (match) return decodeHtmlEntities(match[1]);
    }
    return null;
  };

  const title =
    getMetaContent('og:title') ??
    getMetaContent('twitter:title') ??
    html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ??
    null;

  return {
    url,
    title: title ? decodeHtmlEntities(title) : null,
    description:
      getMetaContent('og:description') ??
      getMetaContent('twitter:description') ??
      getMetaContent('description') ??
      null,
    image:
      getMetaContent('og:image') ??
      getMetaContent('twitter:image') ??
      null,
    siteName:
      getMetaContent('og:site_name') ??
      null,
  };
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/');
}
