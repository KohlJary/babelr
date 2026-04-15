// SPDX-License-Identifier: Hippocratic-3.0
import { listSidebarSlots, type SidebarSlotHostContext } from './sidebar-registry';

interface PluginSidebarSlotsProps {
  host: SidebarSlotHostContext;
}

/**
 * Mounts every registered plugin sidebar slot component. Each plugin
 * manages its own button, modal state, and event wiring — the host
 * contributes only the shared context (actor, selected server,
 * channels, plugin routeBase).
 */
export function PluginSidebarSlots({ host }: PluginSidebarSlotsProps) {
  const slots = listSidebarSlots().filter(
    (slot) => slot.isAvailable?.(host) !== false,
  );
  if (slots.length === 0) return null;
  return (
    <div className="plugin-sidebar-slots">
      {slots.map((slot) => (
        <slot.Component key={slot.id} host={host} />
      ))}
    </div>
  );
}
