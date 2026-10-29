// SPDX-License-Identifier: MIT
/**
 * What's on Kohl, in order (Plans phase 5, "the On you view").
 *
 * Items can wait on other items (`after`, across plans). An item is ready
 * when everything it's after is done; anything downstream of a declined
 * item is stuck and says which. "Next" is the top three ready Kohl items by
 * rank, everywhere, with no cap per path: a chain has one ready item at a
 * time, so two ready in one tree is a fork, and Kohl works forks in
 * parallel. Spreading Next across paths is the ranker's job (RoboKohl);
 * a rank Kohl set is pinned. Pure: the routes load the rows, this sorts.
 */

export interface Node {
  id: string;
  status: 'open' | 'in_progress' | 'done' | 'declined';
  after: string[];
  /** On Kohl: owned by Kohl, or an outreach draft waiting on a send decision. */
  onKohl: boolean;
  owner: string | null;
  rank: number | null;
  createdAt: string;
  /** An outreach draft untouched for over five days. */
  stale: boolean;
}

export interface Placed {
  id: string;
  unlocks: number;
  /** Not-done items it waits on directly (blocked only). */
  waitingOn?: string[];
  /** The declined item upstream of it (stuck only). */
  stuckOn?: string;
}

export interface Buckets {
  next: Placed[];
  more: Placed[];
  blocked: Placed[];
  stuck: Placed[];
}

export const NEXT_MAX = 3;
export const PHASES_NEXT_MAX = 2;

/** Would `id` waiting on `after` close a loop? (Does `after` already wait on `id`?) */
export function makesCycle(
  id: string,
  after: string[],
  edges: Map<string, string[]>,
): string | null {
  for (const start of after) {
    if (start === id) return start;
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length) {
      const n = stack.pop() as string;
      if (n === id) return start;
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...(edges.get(n) ?? []));
    }
  }
  return null;
}

export function place(nodes: Node[]): Buckets {
  const by = new Map(nodes.map((n) => [n.id, n]));
  const down = new Map<string, string[]>();
  for (const n of nodes) {
    for (const a of n.after) down.set(a, [...(down.get(a) ?? []), n.id]);
  }

  /** The Kohl items still to do downstream of `id`, transitively. */
  const unlocks = (id: string) => {
    const seen = new Set<string>();
    const stack = [...(down.get(id) ?? [])];
    while (stack.length) {
      const n = stack.pop() as string;
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...(down.get(n) ?? []));
    }
    let k = 0;
    for (const s of seen) {
      const n = by.get(s);
      if (n?.onKohl && n.status !== 'done' && n.status !== 'declined') k += 1;
    }
    return k;
  };

  /** The first declined item upstream, if any (links to unseen items are ignored). */
  const declinedUpstream = (id: string): string | null => {
    const seen = new Set<string>();
    const stack = [...(by.get(id)?.after ?? [])];
    while (stack.length) {
      const a = stack.pop() as string;
      if (seen.has(a)) continue;
      seen.add(a);
      const n = by.get(a);
      if (!n) continue;
      if (n.status === 'declined') return a;
      if (n.status !== 'done') stack.push(...n.after);
    }
    return null;
  };

  const ready: Node[] = [];
  const out: Buckets = { next: [], more: [], blocked: [], stuck: [] };
  for (const n of nodes) {
    if (!n.onKohl || n.status === 'done' || n.status === 'declined') continue;
    const stuckOn = declinedUpstream(n.id);
    if (stuckOn) {
      out.stuck.push({ id: n.id, unlocks: unlocks(n.id), stuckOn });
      continue;
    }
    const waitingOn = n.after.filter((a) => by.has(a) && by.get(a)?.status !== 'done');
    if (waitingOn.length) out.blocked.push({ id: n.id, unlocks: unlocks(n.id), waitingOn });
    else ready.push(n);
  }

  // Ranked first (1 is first), then fresh before stale, then oldest first.
  ready.sort(
    (a, b) =>
      (a.rank ?? Infinity) - (b.rank ?? Infinity) ||
      Number(a.stale) - Number(b.stale) ||
      a.createdAt.localeCompare(b.createdAt),
  );
  ready.forEach((n, i) =>
    (i < NEXT_MAX ? out.next : out.more).push({ id: n.id, unlocks: unlocks(n.id) }),
  );
  return out;
}
