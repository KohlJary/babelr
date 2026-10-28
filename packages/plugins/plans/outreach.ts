// SPDX-License-Identifier: Hippocratic-3.0
/**
 * Outreach items: RoboKohl's queue files, kept byte for byte (Plans phase 3).
 *
 * An outreach item stores its queue file's raw text. Every change is the
 * same transform RoboKohl's robokohl/queue.py and home.py make (set_field,
 * edit), ported exactly, so exporting the item gives back the file
 * queue.py would have written: unknown header fields, their order and
 * their trailing comments survive, and the `<!-- original -->` block is
 * kept the way queue.edit keeps it. RoboKohl's lessons, wake brief and
 * tests read those files; a lossy export would quietly change them.
 */

export const ORIGINAL = '<!-- original -->';
const FM = /^---\n([\s\S]*?)\n---\n?/;
const KEY_RE = /^[A-Za-z_][\w-]*$/;

/** Python's str.strip() for the whitespace these files hold. */
const strip = (s: string) => s.replace(/^\s+|\s+$/g, '');

/** home.split: (meta, header text, body). Values lose trailing "# comments". */
export function split(text: string): { meta: Record<string, string>; head: string; body: string } {
  const m = FM.exec(text);
  if (!m) return { meta: {}, head: '', body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    if (KEY_RE.test(k))
      meta[k] = line
        .slice(i + 1)
        .replace(/\s+#.*$/, '')
        .trim();
  }
  return { meta, head: m[1], body: text.slice(m[0].length) };
}

/** home.set_field: set one header line, keeping every other line (and comments) as is. */
export function setField(text: string, key: string, value: string): string {
  const m = FM.exec(text);
  const head = m ? m[1] : '';
  const body = m ? text.slice(m[0].length) : text;
  const lines = head.split('\n');
  if (head === '') lines.length = 0;
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pat = new RegExp(`^${esc}:`);
  const i = lines.findIndex((l) => pat.test(l));
  if (i >= 0) {
    const comment = /\s+#.*$/.exec(lines[i]);
    lines[i] = `${key}: ${value}` + (comment ? comment[0] : '');
  } else {
    lines.push(`${key}: ${value}`);
  }
  const rest = strip(body) ? '\n' + body.replace(/^\n+/, '') : '';
  return '---\n' + lines.join('\n') + '\n---\n' + rest;
}

/** Item.draft: the current draft, without the kept original. */
export function draftOf(text: string): string {
  return split(text).body.split(ORIGINAL)[0];
}

/** Item.original: what was first drafted, once someone has edited it. */
export function originalOf(text: string): string | null {
  const body = split(text).body;
  const i = body.indexOf(ORIGINAL);
  return i < 0 ? null : body.slice(i + ORIGINAL.length);
}

/** queue.edit: replace the draft; the first original is kept below ORIGINAL, forever. */
export function edit(text: string, newDraft: string, by: string, today: string): string {
  const draft = draftOf(text);
  if (strip(newDraft) === strip(draft)) return text;
  if (newDraft.replace(/^\s+/, '').startsWith('---\n')) {
    throw new Error('the new draft starts with a frontmatter block; pass the draft body only');
  }
  const body = split(text).body;
  const headEnd = text.length - body.length;
  const kept = originalOf(text);
  const original = kept !== null ? kept : '\n\n' + strip(draft) + '\n';
  let out = text.slice(0, headEnd) + '\n' + strip(newDraft) + '\n\n' + ORIGINAL + original;
  for (const [k, v] of [
    ['status', 'edited'],
    ['edited', today],
    ['edited_by', by],
  ]) {
    out = setField(out, k, v);
  }
  return out;
}

export type SendStatus = 'pending' | 'approved' | 'edited' | 'vetoed' | 'sent';
export const SEND_STATUSES: readonly SendStatus[] = [
  'pending',
  'approved',
  'edited',
  'vetoed',
  'sent',
];

/** queue.approve / veto / mark_sent: header fields only, as queue._write sets them. */
export function decide(
  text: string,
  action: 'approve' | 'veto' | 'sent',
  by: string,
  today: string,
  reason = '',
): string {
  const fields: [string, string][] =
    action === 'approve'
      ? [
          ['status', 'approved'],
          ['approved', today],
          ['approved_by', by],
        ]
      : action === 'veto'
        ? [
            ['status', 'vetoed'],
            ['vetoed', today],
            ['vetoed_by', by],
            ['veto_reason', reason.replace(/\n/g, ' ')],
          ]
        : [
            ['status', 'sent'],
            ['sent', today],
            ['sent_by', by],
          ];
  return fields.reduce((t, [k, v]) => setField(t, k, v), text);
}

/** A line diff, unified-style, for Kohl's edits against the text Kohl saw. */
export function lineDiff(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(' ' + a[i]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push('-' + a[i++]);
    } else {
      out.push('+' + b[j++]);
    }
  }
  while (i < n) out.push('-' + a[i++]);
  while (j < m) out.push('+' + b[j++]);
  return out.join('\n');
}
