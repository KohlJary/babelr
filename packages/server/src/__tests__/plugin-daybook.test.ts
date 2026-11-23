// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { readable } from '@babelr/plugin-daybook';

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
