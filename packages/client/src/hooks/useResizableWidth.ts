// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react';

/**
 * A right-hand column's width, dragged from its left edge: at least `min`,
 * at most half the window (Kohl, 2026-11-23: "letting the sidebars grow to
 * like, half width"). Remembered per `key` in localStorage. Exposed as a CSS
 * variable by the caller so phone layouts can still override it.
 */
export function useResizableWidth(key: string, initial: number, min = 280) {
  const max = () => Math.floor(window.innerWidth * 0.5);
  const clamp = useCallback((w: number) => Math.max(min, Math.min(max(), Math.round(w))), [min]);
  const [width, setWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(`babelr.width.${key}`));
    return saved > 0 ? saved : initial;
  });

  useEffect(() => {
    const onResize = () => setWidth((w) => clamp(w));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clamp]);

  const save = useCallback(
    (w: number) => {
      const c = clamp(w);
      setWidth(c);
      localStorage.setItem(`babelr.width.${key}`, String(c));
    },
    [clamp, key],
  );

  /** Grow to half the window (a daemon showing something), without saving it. */
  const expand = useCallback(() => setWidth(max()), []);

  const onHandleDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const move = (ev: PointerEvent) => setWidth(clamp(window.innerWidth - ev.clientX));
      const up = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        save(window.innerWidth - ev.clientX);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [clamp, save],
  );

  return { width, expand, onHandleDown };
}
