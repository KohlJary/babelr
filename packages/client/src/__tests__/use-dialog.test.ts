// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { trapTarget } from '../hooks/useDialog';

describe('trapTarget (modal focus trap)', () => {
  it('wraps Tab from the last focusable to the first', () => {
    expect(trapTarget(2, 3, false)).toBe(0);
  });

  it('wraps Shift+Tab from the first focusable to the last', () => {
    expect(trapTarget(0, 3, true)).toBe(2);
  });

  it('lets the browser move focus inside the ring', () => {
    expect(trapTarget(0, 3, false)).toBeNull();
    expect(trapTarget(1, 3, false)).toBeNull();
    expect(trapTarget(2, 3, true)).toBeNull();
  });

  it('pulls focus back in when it has escaped the dialog', () => {
    expect(trapTarget(-1, 3, false)).toBe(0);
    expect(trapTarget(-1, 3, true)).toBe(2);
  });

  it('keeps a single focusable focused', () => {
    expect(trapTarget(0, 1, false)).toBe(0);
    expect(trapTarget(0, 1, true)).toBe(0);
  });

  it('does nothing with no focusables', () => {
    expect(trapTarget(-1, 0, false)).toBeNull();
  });
});
