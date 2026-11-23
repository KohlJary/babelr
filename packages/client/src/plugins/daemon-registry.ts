// SPDX-License-Identifier: MIT

/** What a plugin hands a daemon section or door (see ClientDaemonSectionDefinition). */
export interface DaemonSectionProps {
  daemon: { name: string; label: string };
  routeBase: string;
  host: {
    openView: (id: string, state?: Record<string, unknown>) => void;
    /** Open an embed in the sidebar, grown to half the window. */
    openEmbed: (kind: string, slug: string) => void;
  };
}

export interface DaemonSectionDefinition {
  id: string;
  pluginId: string;
  label: string;
  icon?: string;
  order: number;
  place: 'section' | 'door';
  isAvailable?: (daemon: { name: string }) => boolean | Promise<boolean>;
  render?: (props: DaemonSectionProps) => unknown;
  open?: (props: DaemonSectionProps) => void;
  routeBase: string;
}

const sections = new Map<string, DaemonSectionDefinition>();
const listeners = new Set<() => void>();

export function registerDaemonSection(def: DaemonSectionDefinition): void {
  sections.set(`${def.pluginId}:${def.id}`, def);
  for (const l of listeners) l();
}

export function listDaemonSections(): DaemonSectionDefinition[] {
  return [...sections.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}

/** Re-render when plugins register late (they load asynchronously). */
export function onDaemonSectionsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
