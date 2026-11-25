// SPDX-License-Identifier: MIT
import { useEffect, useCallback, type ReactNode } from 'react';

export interface SidePanelProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Width class override. Default is the standard 300px panel. */
  wide?: boolean;
}

export function SidePanel({ title, onClose, children, wide }: SidePanelProps) {
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
    <aside className={`side-panel${wide ? ' side-panel-wide' : ''}`}>
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
