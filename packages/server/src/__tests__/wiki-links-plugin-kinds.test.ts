// SPDX-License-Identifier: Hippocratic-3.0
import { describe, it, expect } from 'vitest';
import { parseWikiRefs } from '@babelr/shared';

/**
 * Plugin-kind parsing lock-in. Before plugin runtime, parseWikiRefs
 * fell back to slugifying unknown prefixes into bare wiki page refs
 * (so [[hello:world]] became a page ref with slug "helloworld").
 * That's wrong under the plugin system — plugin-contributed kinds
 * must parse with their literal prefix as the kind.
 */

describe('parseWikiRefs plugin kinds', () => {
  it('built-in kinds parse to their canonical WikiRefKind', () => {
    const refs = parseWikiRefs(
      'See [[msg:abc]] and [[event:kickoff]] and [[wiki:design]].',
    );
    expect(refs.map((r) => r.kind)).toEqual(['message', 'event', 'page']);
  });

  it('unknown prefixes parse with the prefix as the kind string', () => {
    const refs = parseWikiRefs('Click [[hello:world]] or [[poll:retro]].');
    expect(refs).toHaveLength(2);
    expect(refs[0].kind).toBe('hello');
    expect(refs[0].slug).toBe('world');
    expect(refs[1].kind).toBe('poll');
    expect(refs[1].slug).toBe('retro');
  });

  it('kind-qualified plugin refs do not fall through to bare wiki page refs', () => {
    // Regression guard: before the plugin-runtime refactor, this
    // parsed as a single bare-slug page ref with slug 'helloworld'.
    const refs = parseWikiRefs('[[hello:world]]');
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe('hello');
    expect(refs[0].slug).toBe('world');
  });

  it('plugin kind names permit letters, digits, and hyphens', () => {
    const refs = parseWikiRefs('[[plugin-v2:some-slug-1]]');
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe('plugin-v2');
    expect(refs[0].slug).toBe('some-slug-1');
  });

  it('bare [[slug]] still resolves as a wiki page ref', () => {
    const refs = parseWikiRefs('Look at [[onboarding]] for details.');
    expect(refs).toHaveLength(1);
    expect(refs[0].kind).toBe('page');
    expect(refs[0].slug).toBe('onboarding');
  });
});
