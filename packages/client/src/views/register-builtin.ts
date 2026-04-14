// SPDX-License-Identifier: Hippocratic-3.0
import { createElement, useEffect, useState } from 'react';
import { registerView } from './registry';
import { EventsPanel } from '../components/EventsPanel';
import { WikiPanel } from '../components/WikiPanel';
import FilesPanel from '../components/FilesPanel';
import * as api from '../api';

/**
 * First-party view registrations: calendar, wiki, files, manual.
 * Each one takes the host context + the per-view scratch state and
 * renders its existing component. The plugin system (when shipped)
 * will call registerView the same way for third-party panels.
 *
 * Per-view state shapes (held generically as Record<string, unknown>
 * by the host; each registration knows its own keys):
 *
 * - calendar: { eventId?: string | null }
 * - wiki:     { slug?: string | null; draft?: { title?: string; content?: string } | null }
 * - files:    { fileId?: string | null }
 * - manual:   { slug?: string | null }
 */
export function registerBuiltinViews(): void {
  registerView({
    id: 'calendar',
    label: '📅 Calendar',
    icon: '📅',
    isAvailable: () => true,
    render: (host, viewState) => {
      const eventId = (viewState.eventId as string | null | undefined) ?? null;
      const dmMode = host.selectedServer === null;
      return createElement(EventsPanel, {
        scope: dmMode ? 'user' : 'server',
        ownerId: dmMode ? host.actor.id : host.selectedServer!.id,
        ownerName: dmMode ? undefined : host.selectedServer!.name,
        actor: host.actor,
        channels: dmMode ? undefined : host.channels,
        canCreate:
          dmMode || ['owner', 'admin', 'moderator'].includes(host.callerRole),
        initialEventId: eventId,
        onClose: host.closeView,
        onGoToChannel: (channelId: string) => host.navCtx.selectChannel(channelId),
      });
    },
  });

  registerView({
    id: 'wiki',
    label: 'Wiki',
    icon: '📖',
    isAvailable: (host) => host.selectedServer !== null,
    render: (host, viewState) => {
      if (!host.selectedServer) return null;
      const slug = (viewState.slug as string | null | undefined) ?? null;
      const draft = (viewState.draft as
        | { title?: string; content?: string }
        | null
        | undefined) ?? null;
      return createElement(WikiPanel, {
        serverId: host.selectedServer.id,
        serverName: host.selectedServer.name,
        callerRole: host.callerRole,
        actor: host.actor,
        initialSlug: slug,
        initialDraft: draft,
        onPreviewEmbed: host.openEmbedPreview,
        onClose: host.closeView,
      });
    },
  });

  registerView({
    id: 'files',
    label: 'Files',
    icon: '📁',
    isAvailable: (host) => host.selectedServer !== null,
    render: (host, viewState) => {
      if (!host.selectedServer) return null;
      const fileId = (viewState.fileId as string | null | undefined) ?? null;
      return createElement(FilesPanel, {
        serverId: host.selectedServer.id,
        serverName: host.selectedServer.name,
        callerRole: host.callerRole,
        actor: host.actor,
        initialFileId: fileId,
        onClose: host.closeView,
      });
    },
  });

  /**
   * Manual is a wiki view against a special seeded "babelr-manual"
   * server — has no entry button (opened via the server sidebar's
   * dedicated manual button). The slug-resolving wrapper handles the
   * lazy serverId fetch.
   */
  registerView({
    id: 'manual',
    label: 'Manual',
    // No icon → no toolbar entry; activated by the server sidebar's
    // manual button which calls openView('manual').
    isAvailable: () => false,
    render: (host, viewState) => {
      const slug = (viewState.slug as string | null | undefined) ?? null;
      return createElement(ManualWrapper, {
        slug,
        actor: host.actor,
        openEmbedPreview: host.openEmbedPreview,
        onClose: host.closeView,
      });
    },
  });
}

interface ManualWrapperProps {
  slug: string | null;
  actor: import('@babelr/shared').ActorProfile;
  openEmbedPreview: (
    kind: import('@babelr/shared').WikiRefKind,
    slug: string,
    serverSlug?: string,
  ) => void;
  onClose: () => void;
}

function ManualWrapper({
  slug,
  actor,
  openEmbedPreview,
  onClose,
}: ManualWrapperProps) {
  const [serverId, setServerId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .getManualServerId()
      .then((res) => {
        if (!cancelled) setServerId(res.serverId);
      })
      .catch(() => {
        if (!cancelled) onClose();
      });
    return () => {
      cancelled = true;
    };
  }, [onClose]);
  if (!serverId) return null;
  return createElement(WikiPanel, {
    serverId,
    serverName: 'Babelr Manual',
    isManual: true,
    actor,
    initialSlug: slug,
    onPreviewEmbed: openEmbedPreview,
    onClose,
  });
}
