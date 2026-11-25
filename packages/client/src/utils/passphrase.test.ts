// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { suggestPassphrase, PASSWORD_MIN_LENGTH } from './passphrase';
import { PASSPHRASE_WORDS } from './passphraseWords';

describe('suggestPassphrase', () => {
  it('is always three hyphenated words from the list, 12+ characters', () => {
    const words = new Set(PASSPHRASE_WORDS);
    for (let i = 0; i < 2000; i++) {
      const phrase = suggestPassphrase();
      expect(phrase).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
      expect(phrase.length).toBeGreaterThanOrEqual(PASSWORD_MIN_LENGTH);
      const parts = phrase.split('-');
      expect(parts).toHaveLength(3);
      for (const w of parts) expect(words.has(w)).toBe(true);
    }
  });

  it('varies', () => {
    const seen = new Set(Array.from({ length: 50 }, () => suggestPassphrase()));
    expect(seen.size).toBeGreaterThan(45);
  });

  it('stays over the minimum even with a list of short words', () => {
    const short = ['ab', 'cd', 'longword'];
    let n = 0;
    // Picks ab, cd, ab (8 chars, too short), then longword, cd, ab.
    const seq = [0, 1, 0, 2, 1, 0];
    const random = (out: Uint32Array) => {
      out[0] = seq[n++ % seq.length];
      return out;
    };
    const phrase = suggestPassphrase(random, short);
    expect(phrase).toBe('longword-cd-ab');
    expect(phrase.length).toBeGreaterThanOrEqual(PASSWORD_MIN_LENGTH);
  });

  it('has a bundled list of common, short, plain words', () => {
    expect(PASSPHRASE_WORDS.length).toBeGreaterThan(900);
    expect(new Set(PASSPHRASE_WORDS).size).toBe(PASSPHRASE_WORDS.length);
    for (const w of PASSPHRASE_WORDS) expect(w).toMatch(/^[a-z]{4,5}$/);
  });
});
