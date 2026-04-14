// SPDX-License-Identifier: Hippocratic-3.0
import { useState, type ReactNode } from 'react';

export interface RightSidebarTab {
  id: string;
  label: ReactNode;
  /** Lazily rendered: only the active tab's content mounts. */
  render: () => ReactNode;
  /** Optional click handler called BEFORE the tab activates. Used by
   *  consumers that need to fetch data on tab open (e.g. wiki history). */
  onActivate?: () => void | Promise<void>;
}

interface RightSidebarProps {
  tabs: RightSidebarTab[];
  /** Tab id that should be selected on first render. Defaults to the
   *  first tab. Pass `null` to render with no tab selected (tabs act
   *  as togglable opens; clicking the active tab closes the panel). */
  defaultTab?: string | null;
  /** Style hook — consumers can scope their own CSS rules. */
  className?: string;
}

/**
 * Tabbed right sidebar shared between voice CallView, wiki pages, file
 * detail, event detail, etc. Each consumer rolls their own panel
 * content; this component owns the tab strip, selected-tab state, and
 * the content slot.
 */
export function RightSidebar({
  tabs,
  defaultTab,
  className,
}: RightSidebarProps) {
  const initial =
    defaultTab === null
      ? null
      : (defaultTab ?? tabs[0]?.id ?? null);
  const [activeId, setActiveId] = useState<string | null>(initial);
  const active = tabs.find((t) => t.id === activeId);

  const handleClick = async (tab: RightSidebarTab) => {
    if (activeId === tab.id) {
      // Toggle off — match the wiki/event/file behavior of clicking the
      // active tab to collapse the panel.
      setActiveId(null);
      return;
    }
    if (tab.onActivate) await tab.onActivate();
    setActiveId(tab.id);
  };

  return (
    <aside className={`right-sidebar ${className ?? ''}`}>
      <div className="right-sidebar-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`right-sidebar-tab ${activeId === tab.id ? 'active' : ''}`}
            onClick={() => void handleClick(tab)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {active && (
        <div className="right-sidebar-content">{active.render()}</div>
      )}
    </aside>
  );
}
