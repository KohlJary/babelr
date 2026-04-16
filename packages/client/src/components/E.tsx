// SPDX-License-Identifier: Hippocratic-3.0
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { ActorProfile, WikiRefKind } from '@babelr/shared';
import { renderWithEmbeds } from '../utils/render-with-embeds';
import { useTranslateStrings } from '../hooks/useTranslateStrings';
import { useTranslationSettings } from '../hooks/useTranslationSettings';

/**
 * Host context for `<E>`. ChatView provides the single instance at the
 * app root; plugins rendered inside a view/sidebar slot just read from
 * it. The translation pipeline already masks [[kind:slug]] tokens
 * through its transforms, so translate-then-render is safe.
 */
export interface EmbedHost {
  actor: ActorProfile;
  onPreviewEmbed: (kind: WikiRefKind, slug: string, serverSlug?: string) => void;
}

const EmbedHostContext = createContext<EmbedHost | null>(null);

export function EmbedHostProvider({
  host,
  children,
}: {
  host: EmbedHost;
  children: ReactNode;
}) {
  return <EmbedHostContext.Provider value={host}>{children}</EmbedHostContext.Provider>;
}

interface EProps {
  children: string;
  /** Override the rendering variant. Defaults to 'chat' (markdown + embeds
   *  suitable for message-like content). Use 'wiki' for wiki-markdown. */
  variant?: 'chat' | 'wiki';
}

/**
 * `<E>{content}</E>` — translate plaintext *and* render any inline
 * `[[kind:slug]]` embeds inside it. The translation pipeline masks
 * embed tokens on the way out and restores them on the way back, so
 * the translated output still contains the original refs for
 * renderWithEmbeds to expand.
 *
 * Use this for user-authored prose that might contain embeds —
 * message bodies, wiki content, work-item descriptions. For raw
 * labels with no embed surface (titles, badges), keep using `<T>`.
 *
 * Falls back to plain translated text if no EmbedHost is provided
 * (preview will still work; clicks just won't open a sidebar).
 */
export function E({ children, variant = 'chat' }: EProps) {
  const { settings } = useTranslationSettings();
  const strings = useMemo(() => ({ text: children }), [children]);
  const translated = useTranslateStrings(strings, settings);
  const host = useContext(EmbedHostContext);
  const content = translated.text ?? children;
  return (
    <>
      {renderWithEmbeds(content, {
        variant,
        onPreviewEmbed: host?.onPreviewEmbed,
        actor: host?.actor,
      })}
    </>
  );
}
