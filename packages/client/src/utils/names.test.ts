// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { nameFromUsername } from './names';

describe('nameFromUsername', () => {
  it('writes a username like a name', () => {
    expect(nameFromUsername('barbara')).toBe('Barbara');
    expect(nameFromUsername('mary_ann')).toBe('Mary Ann');
    expect(nameFromUsername('Luna')).toBe('Luna');
    expect(nameFromUsername('_x__y_')).toBe('X Y');
  });
});
