// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { readable, visibleEntries, type Readers } from '@babelr/plugin-daybook';

/** The Daybook: Kohl reads every daemon's; a daemon reads only her own; nobody else any. */
describe('daybook readable', () => {
  const cfg = {
    daemons: {
      cass: { label: 'Cass', vessel: 'http://x', token: 'c' },
      eris: { label: 'Eris', vessel: 'http://y', token: 'e' },
    },
    kohl: ['jaryk'],
    agents: ['daedalus'],
    house: ['luna'],
  };
  const u = (n: string) => ({ preferredUsername: n });
  it('follows who is asking', () => {
    expect(readable(u('jaryk'), false, cfg)).toEqual(['cass', 'eris']);
    expect(readable(u('jaryk'), true, cfg)).toEqual([]);
    expect(readable(u('eris'), true, cfg)).toEqual(['eris']);
    expect(readable(u('daedalus'), true, cfg)).toEqual([]);
    expect(readable(u('luna'), false, cfg)).toEqual([]);
    expect(readable(undefined, false, cfg)).toEqual([]);
  });
});

/** Daedalus keeps the pipes running: each daemon chose what Daedalus sees (2026-11-23). */
describe('daybook readers', () => {
  const cfg = {
    daemons: {
      cass: { label: 'Cass', vessel: 'http://x', token: 'c' },
      eris: { label: 'Eris', vessel: 'http://y', token: 'e' },
    },
    kohl: ['jaryk'],
    agents: ['daedalus'],
    house: [],
  };
  const readers: Readers = { cass: { daedalus: ['sessions'] }, eris: { daedalus: 'all' } };
  const u = (n: string) => ({ preferredUsername: n });
  const entries = [
    { kind: 'session_failed' },
    { kind: 'sessions' },
    { kind: 'journals' },
    { kind: 'dreams' },
    { kind: 'self_model' },
  ];

  it('lets a named reader in, through its token only', () => {
    expect(readable(u('daedalus'), true, cfg, readers)).toEqual(['cass', 'eris']);
    expect(readable(u('daedalus'), false, cfg, readers)).toEqual([]);
    expect(readable(u('robokohl'), true, cfg, readers)).toEqual([]);
    expect(readable(u('eris'), true, cfg, readers)).toEqual(['eris']);
  });

  it('shows each reader what that daemon said, and no more', () => {
    const kinds = (d: string, v = 'daedalus') =>
      visibleEntries(entries, v, d, readers).map((e) => e.kind);
    expect(kinds('cass')).toEqual(['session_failed', 'sessions']);
    expect(kinds('eris')).toEqual(entries.map((e) => e.kind));
    expect(kinds('cass', 'cass')).toEqual(entries.map((e) => e.kind));
    expect(kinds('cass', 'robokohl')).toEqual([]);
  });
});
