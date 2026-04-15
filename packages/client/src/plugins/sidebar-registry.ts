// SPDX-License-Identifier: Hippocratic-3.0
import type { ComponentType } from 'react';
import type { ActorProfile, ChannelView } from '@babelr/shared';

/**
 * Sidebar-slot registry — plugins mount arbitrary components in the
 * left sidebar (below the built-in Calendar/Wiki/Files buttons). Each
 * slot component owns its own UI state, modals, event handlers, etc.
 * The host just iterates registered slots and mounts them.
 *
 * This is deliberately a thin seam: the registry doesn't know about
 * buttons or modals or click handlers. A plugin author who wants a
 * "New Poll" button writes a component that renders a button and a
 * modal; a plugin author who wants a persistent widget (recent activity
 * ticker, online friend count, etc.) writes that instead. Same slot,
 * different content.
 */

export interface SidebarSlotHostContext {
  actor: ActorProfile;
  selectedServerId: string | null;
  selectedServerName: string | null;
  /** The channels visible to the user in this server (empty for DM
   *  mode). Useful for plugins that need to know what the user has
   *  access to — e.g. a channel picker inside a modal. */
  channels: ChannelView[];
  /** Plugin's route base (/api/plugins/<id>). Plugins fetch against
   *  this to talk to their own server routes. */
  routeBase: string;
  /** Activate a registered main-panel view with optional initial
   *  state. Plugin sidebar slots use this to open their own views
   *  when clicked — same primitive the first-party Calendar/Wiki/Files
   *  buttons use. */
  openView: (id: string, state?: Record<string, unknown>) => void;
}

export interface SidebarSlotDefinition {
  id: string;
  /** Component mounted for this slot. Receives the host context +
   *  nothing else. The component is responsible for everything: its
   *  own button, modal, event wiring, teardown. */
  Component: ComponentType<{ host: SidebarSlotHostContext }>;
  /** Optional predicate. Called each render; if false, the slot is
   *  not mounted. Common shape: "only show when a server is selected,"
   *  "only show when the caller has role X." */
  isAvailable?: (host: SidebarSlotHostContext) => boolean;
}

const registry = new Map<string, SidebarSlotDefinition>();
const order: string[] = [];

export function registerSidebarSlot(def: SidebarSlotDefinition): void {
  if (!registry.has(def.id)) order.push(def.id);
  registry.set(def.id, def);
}

export function listSidebarSlots(): SidebarSlotDefinition[] {
  return order.map((id) => registry.get(id)!).filter(Boolean);
}
