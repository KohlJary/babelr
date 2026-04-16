// SPDX-License-Identifier: Hippocratic-3.0
import { useState, type ReactNode } from 'react';

export interface Tab {
  id: string;
  label: string;
  icon?: ReactNode;
}

export interface TabbedViewProps {
  tabs: Tab[];
  /** Controlled active tab. Omit for uncontrolled mode (first tab). */
  activeTab?: string;
  onTabChange?: (tabId: string) => void;
  renderContent: (tabId: string) => ReactNode;
  /** Header title above the tab bar. */
  title?: string;
  /** Close button callback. */
  onClose?: () => void;
}

export function TabbedView({
  tabs,
  activeTab: controlledTab,
  onTabChange,
  renderContent,
  title,
  onClose,
}: TabbedViewProps) {
  const [internalTab, setInternalTab] = useState(tabs[0]?.id ?? '');
  const activeTab = controlledTab ?? internalTab;

  const handleTabChange = (id: string) => {
    if (!controlledTab) setInternalTab(id);
    onTabChange?.(id);
  };

  return (
    <div className="tabbed-view">
      <header className="tabbed-view-header">
        {title && <h2 className="tabbed-view-title">{title}</h2>}
        {onClose && (
          <button
            type="button"
            className="tabbed-view-close"
            onClick={onClose}
            aria-label="Close"
          >
            &times;
          </button>
        )}
      </header>
      <nav className="tabbed-view-tabs" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            className={`tabbed-view-tab${activeTab === tab.id ? ' active' : ''}`}
            aria-selected={activeTab === tab.id}
            onClick={() => handleTabChange(tab.id)}
          >
            {tab.icon && <span className="tabbed-view-tab-icon">{tab.icon}</span>}
            {tab.label}
          </button>
        ))}
      </nav>
      <div className="tabbed-view-content" role="tabpanel">
        {renderContent(activeTab)}
      </div>
    </div>
  );
}
