// SPDX-License-Identifier: Hippocratic-3.0
import type { ActorProfile, WikiRefKind } from '@babelr/shared';
import { getEmbed } from '../embeds/registry';
import type { EmbedNavCtx } from '../embeds/registry';
import { useT } from '../i18n/I18nProvider';

export interface EmbedSidebarTarget {
  kind: WikiRefKind;
  slug: string;
  serverSlug?: string;
}

interface EmbedSidebarProps {
  target: EmbedSidebarTarget;
  actor: ActorProfile;
  serverId: string | null;
  navCtx: EmbedNavCtx;
  onClose: () => void;
}

/**
 * Right-sidebar host that displays an embed's preview content for a
 * given target (kind + slug). Header shows the kind label, a close
 * button, and an "Open in [X]" navigation button that hands off to
 * the registry's `navigate` (typically routing the user to the full-
 * size view for that kind).
 */
export function EmbedSidebar({
  target,
  actor,
  serverId,
  navCtx,
  onClose,
}: EmbedSidebarProps) {
  const t = useT();
  const def = getEmbed(target.kind);
  if (!def) {
    return (
      <aside className="embed-sidebar">
        <header className="embed-sidebar-header">
          <span className="embed-sidebar-title">Unknown embed</span>
          <button className="embed-sidebar-close" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="embed-sidebar-body">
          No registered preview for kind &quot;{target.kind}&quot;.
        </div>
      </aside>
    );
  }
  return (
    <aside className="embed-sidebar">
      <header className="embed-sidebar-header">
        <span className="embed-sidebar-title">{def.label}</span>
        <div className="embed-sidebar-actions">
          <button
            className="embed-sidebar-open"
            onClick={() => {
              def.navigate({ slug: target.slug, serverSlug: target.serverSlug }, navCtx);
              onClose();
            }}
            title={def.navigateLabel}
          >
            {def.navigateLabel}
          </button>
          <button
            className="embed-sidebar-close"
            onClick={onClose}
            title={t('common.close')}
          >
            ×
          </button>
        </div>
      </header>
      <div className="embed-sidebar-body">
        {def.renderPreview({
          slug: target.slug,
          serverSlug: target.serverSlug,
          actor,
          serverId,
          onNavigate: () => {
            def.navigate({ slug: target.slug, serverSlug: target.serverSlug }, navCtx);
            onClose();
          },
        })}
      </div>
    </aside>
  );
}
