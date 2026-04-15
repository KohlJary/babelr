// SPDX-License-Identifier: Hippocratic-3.0
import type { ComponentType } from 'react';
import type { ActorProfile, WikiRefKind } from '@babelr/shared';

/**
 * Embed registry — the single extension point for inline/preview/navigate
 * behavior of `[[kind:slug]]` references in messages and wiki content.
 *
 * First-party kinds (page, manual, message, event, file, image) register
 * at app boot. The plugin system (when shipped) registers third-party
 * kinds against the same API, so plugin authors get full parity with
 * built-in embed types — including their own sidebar preview UI.
 */

/** Props handed to renderInline. */
export interface EmbedInlineProps {
  slug: string;
  /** Local server slug for cross-server (same-tower) refs. */
  serverSlug?: string;
  /** Click handler — call to open the preview sidebar. */
  onClick: () => void;
  /** Actor for any sub-feature that needs identity (e.g. comments). */
  actor?: ActorProfile;
}

/** Props handed to renderPreview. */
export interface EmbedPreviewProps {
  slug: string;
  serverSlug?: string;
  actor: ActorProfile;
  /** Currently-selected server id in the host. Wiki page previews use
   *  this to resolve which server's page to fetch. Plugins that scope
   *  to a server use it the same way. */
  serverId: string | null;
  /** Called when the user clicks "Open in [X]" — the sidebar host
   *  routes this through the registry's `navigate`. */
  onNavigate: () => void;
}

/**
 * Navigation context provided by the host (ChatView). Compact surface
 * — embed navigate handlers either jump to another channel or open a
 * registered view with some initial state. The view registry handles
 * per-view setup.
 */
export interface EmbedNavCtx {
  selectChannel: (channelId: string) => void;
  /** Open a registered view in the main panel with optional initial
   *  state (deep-link slug, eventId, fileId, etc.). */
  openView: (id: string, state?: Record<string, unknown>) => void;
  /** Close any active view (return to the chat default). */
  closeView: () => void;
}

/** Data the navigate handler needs (kind-specific). Slug is always
 *  available; serverSlug for cross-server refs. */
export interface EmbedNavigateArgs {
  slug: string;
  serverSlug?: string;
}

export interface EmbedDefinition {
  kind: WikiRefKind;
  /** Display label for the sidebar header and "Open in [X]" button. */
  label: string;
  /** Verb shown on the navigation button, e.g. "Open in Wiki". */
  navigateLabel: string;
  /** React component rendered inline inside a message/wiki page.
   *  Hosts mount it via createElement, so hooks inside are tracked
   *  against this component (not the surrounding renderer). */
  Inline: ComponentType<EmbedInlineProps>;
  /** React component rendered inside the right-sidebar preview. */
  Preview: ComponentType<EmbedPreviewProps>;
  navigate: (args: EmbedNavigateArgs, ctx: EmbedNavCtx) => void;
}

const registry = new Map<WikiRefKind, EmbedDefinition>();

export function registerEmbed(def: EmbedDefinition): void {
  registry.set(def.kind, def);
}

export function getEmbed(kind: WikiRefKind): EmbedDefinition | undefined {
  return registry.get(kind);
}

export function listEmbeds(): EmbedDefinition[] {
  return Array.from(registry.values());
}
