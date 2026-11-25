// SPDX-License-Identifier: MIT
import { PASSPHRASE_WORDS } from './passphraseWords';

/** The server's minimum (auth.ts, settings change-password). */
export const PASSWORD_MIN_LENGTH = 12;

/** Fills `out` with random 32-bit values. Swappable for tests. */
export type RandomSource = (out: Uint32Array) => Uint32Array;

const cryptoRandom: RandomSource = (out) => crypto.getRandomValues(out);

/** A uniform index below `n`, by rejection so no word is favoured. */
function randomIndex(n: number, random: RandomSource): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    const v = random(buf)[0];
    if (v < limit) return v % n;
  }
}

/**
 * Three random common words joined by hyphens, e.g. `copper-meadow-lantern`.
 * Easy to write down and to type on a phone, and always over the minimum.
 */
export function suggestPassphrase(
  random: RandomSource = cryptoRandom,
  words: readonly string[] = PASSPHRASE_WORDS,
): string {
  for (;;) {
    const picked = [0, 1, 2].map(() => words[randomIndex(words.length, random)]);
    const phrase = picked.join('-');
    // The bundled words make this always true; the check keeps the promise
    // if the list ever changes.
    if (phrase.length >= PASSWORD_MIN_LENGTH) return phrase;
  }
}
