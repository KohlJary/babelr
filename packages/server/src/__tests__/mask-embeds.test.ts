// SPDX-License-Identifier: Hippocratic-3.0
import { describe, it, expect } from 'vitest';
import { maskEmbeds, restoreEmbeds } from '@babelr/shared';

describe('maskEmbeds + restoreEmbeds', () => {
  it('round-trips a string with no embed refs unchanged', () => {
    const src = 'Hello world, this is a normal sentence.';
    const { masked, tokens } = maskEmbeds(src);
    expect(masked).toBe(src);
    expect(tokens).toEqual([]);
    expect(restoreEmbeds(masked, tokens)).toBe(src);
  });

  it('masks a single message ref and restores it verbatim', () => {
    const src = 'See [[msg:abc12345]] for context.';
    const { masked, tokens } = maskEmbeds(src);
    expect(masked).toBe('See \u27E6E0\u27E7 for context.');
    expect(tokens).toEqual(['[[msg:abc12345]]']);
    expect(restoreEmbeds(masked, tokens)).toBe(src);
  });

  it('handles multiple refs of mixed kinds', () => {
    const src =
      'Pinning [[msg:abc12345]] and the [[event:weekly-sync]] alongside [[wiki:design-doc]].';
    const { masked, tokens } = maskEmbeds(src);
    expect(masked).toContain('\u27E6E0\u27E7');
    expect(masked).toContain('\u27E6E1\u27E7');
    expect(masked).toContain('\u27E6E2\u27E7');
    expect(tokens).toHaveLength(3);
    expect(restoreEmbeds(masked, tokens)).toBe(src);
  });

  it('survives the LLM rewriting surrounding text but preserving placeholders', () => {
    const src = 'The decision is in [[msg:abc12345]] — read it.';
    const { tokens } = maskEmbeds(src);
    // Simulate the LLM having translated the surrounding text into French
    // while preserving the placeholder verbatim.
    const fakeTranslation = 'La décision est dans \u27E6E0\u27E7 — lisez-la.';
    expect(restoreEmbeds(fakeTranslation, tokens)).toBe(
      'La décision est dans [[msg:abc12345]] — lisez-la.',
    );
  });

  it('handles cross-tower refs as a single masked unit', () => {
    const src = 'Reference [[partner@partner.example.com:wiki:onboarding]] inline.';
    const { masked, tokens } = maskEmbeds(src);
    expect(masked).toBe('Reference \u27E6E0\u27E7 inline.');
    expect(tokens[0]).toBe('[[partner@partner.example.com:wiki:onboarding]]');
    expect(restoreEmbeds(masked, tokens)).toBe(src);
  });
});
