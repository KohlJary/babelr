// SPDX-License-Identifier: MIT
import { useEffect, useRef } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The focusable elements inside `root`, in tab order (visible ones only). */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.getClientRects().length > 0,
  );
}

/**
 * Where Tab should go from the element at `index` in a ring of `count`
 * focusables, or null to let the browser move focus itself. `index` is -1
 * when focus is outside the ring.
 */
export function trapTarget(index: number, count: number, shift: boolean): number | null {
  if (count === 0) return null;
  if (index === -1) return shift ? count - 1 : 0;
  if (shift && index === 0) return count - 1;
  if (!shift && index === count - 1) return 0;
  return null;
}

/**
 * Modal dialog behaviour for the element the returned ref is attached to:
 * Escape calls `onClose`, Tab and Shift+Tab stay inside it, focus moves in
 * when it opens (unless something inside already took it, e.g. autoFocus)
 * and goes back to where it was when it closes.
 *
 * Escape is handled on the document's bubble phase and skipped when
 * something nearer already handled it (`defaultPrevented`), so an inner
 * control such as a message being edited gets Escape first.
 */
export function useDialog<T extends HTMLElement = HTMLDivElement>(onClose: () => void) {
  const ref = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const previous = document.activeElement as HTMLElement | null;
    if (!root.contains(document.activeElement)) {
      const first = focusableIn(root)[0];
      if (first) first.focus();
      else {
        root.tabIndex = -1;
        root.focus();
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (e.defaultPrevented) return;
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusableIn(root);
      const index = items.indexOf(document.activeElement as HTMLElement);
      const target = trapTarget(index, items.length, e.shiftKey);
      if (items.length === 0) {
        e.preventDefault();
      } else if (target !== null) {
        e.preventDefault();
        items[target].focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, []);

  return ref;
}
