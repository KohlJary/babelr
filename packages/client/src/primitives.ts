// SPDX-License-Identifier: Hippocratic-3.0

/**
 * Public API surface for reusable view primitives. Plugin authors and
 * internal surfaces import from here rather than reaching into
 * individual component files.
 *
 * Available primitives:
 *   - ListDetailView — searchable left rail + detail panel
 *   - TabbedView     — tab bar + content panels
 *   - ScrollListView — scrollable list with search + pagination
 *   - SidePanel      — right-side panel with close + escape
 *   - T              — translate plaintext
 *   - E              — translate + render embeds in prose
 */

export { ListDetailView } from './components/ListDetailView.js';
export type { ListDetailViewProps } from './components/ListDetailView.js';

export { TabbedView } from './components/TabbedView.js';
export type { TabbedViewProps, Tab } from './components/TabbedView.js';

export { ScrollListView } from './components/ScrollListView.js';
export type { ScrollListViewProps } from './components/ScrollListView.js';

export { SidePanel } from './components/SidePanel.js';
export type { SidePanelProps } from './components/SidePanel.js';

export { T } from './components/T.js';
export { E, EmbedHostProvider } from './components/E.js';
export type { EmbedHost } from './components/E.js';
