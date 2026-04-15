// SPDX-License-Identifier: Hippocratic-3.0
import type { ComponentType, ReactNode } from 'react';
import type { ActorProfile, ChannelView, WikiRefKind } from '@babelr/shared';
import type { EmbedNavCtx } from '../embeds/registry';

/**
 * View registry — the single extension point for main-panel views in
 * ChatView. Mirrors the embed registry shape: first-party views
 * (calendar, wiki, files, manual) register at app boot; plugins
 * register against the same API to ship their own panels.
 *
 * The chat (message list) is the always-on default background — when
 * no view is active, the message list shows. When a view IS active,
 * its `render` fills the chat-panel slot.
 */

export interface ServerSummary {
  id: string;
  name: string;
  /** Optional — needed by some views (file/wiki) for federation context. */
  uri?: string;
}

/**
 * Cross-cutting primitives a view's render function can rely on. The
 * host (ChatView) builds and provides this each render. Plugin authors
 * pull what they need; built-in views do the same.
 */
export interface ViewHostContext {
  actor: ActorProfile;
  selectedServer: ServerSummary | null;
  callerRole: string;
  channels: ChannelView[];
  /** Navigation primitives (same shape used by the embed registry's
   *  navigate handlers). Lets a view jump to another channel, switch
   *  to another view, etc. */
  navCtx: EmbedNavCtx;
  /** Open an embed in the right sidebar — handy for views that render
   *  rich content with [[kind:slug]] refs (e.g. event descriptions). */
  openEmbedPreview: (kind: WikiRefKind, slug: string, serverSlug?: string) => void;
  /** Close the active view (returns to the chat default). Bound to
   *  the X / "back to chat" button each view typically renders. */
  closeView: () => void;
}

/**
 * Per-view scratch state held by the host. Free-form so plugin authors
 * can store whatever they need (deep-link entry, scroll position,
 * wizard step, etc.). Built-in examples: wiki uses { slug?, draft? };
 * calendar uses { eventId? }; files uses { fileId? }.
 */
export type ViewState = Record<string, unknown>;

export interface ViewProps {
  host: ViewHostContext;
  viewState: ViewState;
}

export interface ViewDefinition {
  id: string;
  label: string;
  /** Icon shown in the sidebar entry button. Omit if the view is
   *  triggered from elsewhere (embed click, command palette, etc.) and
   *  shouldn't appear in the toolbar. */
  icon?: ReactNode;
  /** When does this view's entry button appear? Common predicate:
   *  "needs a selected server" for server-scoped views. */
  isAvailable?: (host: ViewHostContext) => boolean;
  /** React component that renders the view's main-panel content. Hosts
   *  mount it via createElement so hooks inside are tracked against
   *  this component, not the host's render cycle. */
  View: ComponentType<ViewProps>;
}

const registry = new Map<string, ViewDefinition>();
const order: string[] = [];

export function registerView(def: ViewDefinition): void {
  if (!registry.has(def.id)) order.push(def.id);
  registry.set(def.id, def);
}

export function getView(id: string): ViewDefinition | undefined {
  return registry.get(id);
}

/** All registered views in registration order — used by the host to
 *  build the sidebar entry list. */
export function listViews(): ViewDefinition[] {
  return order.map((id) => registry.get(id)!).filter(Boolean);
}
