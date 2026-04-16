// SPDX-License-Identifier: Hippocratic-3.0
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
      if (e.key === 'Escape') onClose();
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
        <button
          type="button"
          className="side-panel-close"
          onClick={onClose}
          aria-label="Close"
        >
          &times;
        </button>
      </header>
      <div className="side-panel-body">{children}</div>
    </aside>
  );
}
