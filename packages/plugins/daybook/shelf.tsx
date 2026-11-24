// SPDX-License-Identifier: MIT
import { Markdown } from '@babelr/plugin-panel/client';

/**
 * What the Daybook hands the right sidebar (Kohl, 2026-11-24: "clicking on,
 * like, anything within the page should open the right sidebar with the full
 * contents for review"). The page already holds every entry's full text, so
 * the view puts what was clicked on this shelf and opens a `daybook` embed
 * whose slug is the shelf key; the preview reads it back. Nothing is fetched
 * again, and nothing leaves the viewer's browser.
 */

export interface ShelfEntry {
  at?: string;
  title: string;
  detail?: string;
  meta?: string;
}

export interface ShelfItem {
  /** Whose it is ("Eris"), and its color. */
  who: string;
  hue?: string;
  /** What kind of thing ("Journal", "Coming up today"). */
  kind: string;
  /** One entry, or several (a folded run, a calendar chip with many). */
  entries: ShelfEntry[];
}

const shelf = new Map<string, ShelfItem>();
let n = 0;

export function shelve(item: ShelfItem): string {
  const key = `dbk-${Date.now().toString(36)}-${(n++).toString(36)}`;
  shelf.set(key, item);
  if (shelf.size > 200) shelf.delete(shelf.keys().next().value as string);
  return key;
}

/** Her own markers (<mark:differentiation> ...) are hers, not for the page. */
export const unmark = (s = '') => s.replace(/<\/?mark(?::[^>]*)?>/g, '');

const when = (at?: string) => {
  if (!at) return '';
  const d = new Date(at.length <= 10 ? `${at}T12:00:00` : at);
  if (!Number.isFinite(d.getTime())) return at;
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(at.length > 10 ? { hour: 'numeric', minute: '2-digit' } : {}),
  });
};

export function DaybookPreview(props: { slug: string }) {
  const item = shelf.get(props.slug);
  if (!item) {
    return (
      <p style={{ opacity: 0.7 }}>
        This was opened from an earlier visit to the Daybook. Open the Daybook and pick it again.
      </p>
    );
  }
  return (
    <div style={{ lineHeight: 1.55 }}>
      <div
        style={{
          color: item.hue ?? 'inherit',
          fontWeight: 700,
          fontSize: '.8rem',
          letterSpacing: '.06em',
          marginBottom: '.6rem',
        }}
      >
        {item.who} · {item.kind}
      </div>
      {item.entries.map((e, i) => (
        <article
          key={i}
          style={{
            marginBottom: '1.1rem',
            paddingBottom: item.entries.length > 1 ? '1rem' : 0,
            borderBottom:
              item.entries.length > 1 && i < item.entries.length - 1
                ? '1px solid var(--border-color, #333)'
                : 'none',
          }}
        >
          <h3 style={{ margin: '0 0 .2rem', fontSize: '1.05rem' }}>{e.title}</h3>
          {e.at && (
            <div style={{ opacity: 0.65, fontSize: '.82rem', marginBottom: '.5rem' }}>
              {when(e.at)}
            </div>
          )}
          {e.detail ? (
            <Markdown text={unmark(e.detail)} />
          ) : (
            <p style={{ opacity: 0.7 }}>No text.</p>
          )}
          {e.meta && <p style={{ opacity: 0.65, fontSize: '.82rem' }}>{e.meta}</p>}
        </article>
      ))}
    </div>
  );
}
