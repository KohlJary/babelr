// SPDX-License-Identifier: MIT
import { useEffect, useRef } from 'react';

/**
 * Phones and tablets (stopgap until the shell has a router): while a panel is
 * shown as a sheet, the system back gesture closes it instead of leaving the
 * app. Pushes one history entry when the sheet opens and pops it again when
 * the sheet closes some other way (× or Escape).
 *
 * The push waits a tick so React StrictMode's mount/unmount/mount in dev
 * doesn't leave a stray entry behind.
 */
export function useSheetBack(active: boolean, onClose: () => void, query = '(max-width: 1024px)') {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!active || typeof window === 'undefined') return;
    if (!window.matchMedia?.(query).matches) return;
    const id = `sheet-${Math.random().toString(36).slice(2)}`;
    let pushed = false;
    let popped = false;
    const onPop = () => {
      if (window.history.state?.babelrSheet === id) return;
      popped = true;
      closeRef.current();
    };
    const timer = window.setTimeout(() => {
      window.history.pushState({ ...(window.history.state ?? {}), babelrSheet: id }, '');
      pushed = true;
      window.addEventListener('popstate', onPop);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('popstate', onPop);
      if (pushed && !popped && window.history.state?.babelrSheet === id) window.history.back();
    };
  }, [active, query]);
}
