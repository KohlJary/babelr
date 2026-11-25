// SPDX-License-Identifier: MIT
import { useEffect, useCallback, type ReactNode } from 'react';
import { useSheetBack } from '../hooks/useSheetBack';

export interface SidePanelProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Width class override. Default is the standard 300px panel. */
  wide?: boolean;
  /**
   * At 1024px and below the panel is a full-screen sheet over the chat.
   * A panel that is only ambient context (the members list beside a
   * channel) stays hidden there unless asked for: pass true to hide it.
   */
  hiddenWhenNarrow?: boolean;
}

export function SidePanel({ title, onClose, children, wide, hiddenWhenNarrow }: SidePanelProps) {
  useSheetBack(!hiddenWhenNarrow, onClose);
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Escape is for the innermost thing: skip it when something nearer
      // (an edit box, a picker) already handled it, or a modal is open.
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      onClose();
    },
    [onClose],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return (
    <aside
      className={`side-panel${wide ? ' side-panel-wide' : ''}${
        hiddenWhenNarrow ? ' side-panel-narrow-hidden' : ''
      }`}
    >
      <header className="side-panel-header">
        <h3 className="side-panel-title">{title}</h3>
        <button type="button" className="side-panel-close" onClick={onClose} aria-label="Close">
          &times;
        </button>
      </header>
      <div className="side-panel-body">{children}</div>
    </aside>
  );
}
