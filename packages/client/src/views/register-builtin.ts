// SPDX-License-Identifier: Hippocratic-3.0
import { createElement, useEffect, useState } from 'react';
import { registerView, type ViewProps } from './registry';
import { EventsPanel } from '../components/EventsPanel';
import { WikiPanel } from '../components/WikiPanel';
import FilesPanel from '../components/FilesPanel';
import { SettingsPanel } from '../components/SettingsPanel';
import { ServerSettingsPanel } from '../components/ServerSettingsPanel';
import { ChannelSettingsPanel } from '../components/ChannelSettingsPanel';
import { FriendsPanel } from '../components/FriendsPanel';
import { MentionsPanel } from '../components/MentionsPanel';
import * as api from '../api';

/**
 * First-party view registrations: calendar, wiki, files, manual.
 * Each is a proper React component (ComponentType<ViewProps>) so the
 * host mounts it via createElement and its hooks are tracked against
 * the component instance — not leaking into the caller's render cycle.
 *
 * viewState is the free-form scratch space the host stores alongside
 * activeViewId. Per-view keys below:
 *   - calendar: { eventId?: string | null }
 *   - wiki:     { slug?: string | null; draft?: { title?: string; content?: string } | null }
 *   - files:    { fileId?: string | null }
 *   - manual:   { slug?: string | null }
 */

function CalendarView({ host, viewState }: ViewProps) {
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
}

function WikiView({ host, viewState }: ViewProps) {
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
}

function FilesView({ host, viewState }: ViewProps) {
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
}

/**
 * Manual wraps WikiPanel pointed at the special seeded manual server.
 * Resolves that server id lazily on first mount.
 */
function ManualView({ host, viewState }: ViewProps) {
  const slug = (viewState.slug as string | null | undefined) ?? null;
  const [serverId, setServerId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .getManualServerId()
      .then((res) => {
        if (!cancelled) setServerId(res.serverId);
      })
      .catch(() => {
        if (!cancelled) host.closeView();
      });
    return () => {
      cancelled = true;
    };
  }, [host]);
  if (!serverId) return null;
  return createElement(WikiPanel, {
    serverId,
    serverName: 'Babelr Manual',
    isManual: true,
    actor: host.actor,
    initialSlug: slug,
    onPreviewEmbed: host.openEmbedPreview,
    onClose: host.closeView,
  });
}

function ServerSettingsView({ host }: ViewProps) {
  if (!host.selectedServer) return null;
  const [server, setServer] = useState<import('@babelr/shared').ServerView | null>(null);
  useEffect(() => {
    api.getServer(host.selectedServer!.id).then(setServer).catch(() => {});
  }, [host.selectedServer]);
  if (!server) return null;
  return createElement(ServerSettingsPanel, {
    server,
    onClose: host.closeView,
    onUpdated: (s: import('@babelr/shared').ServerView) => setServer(s),
  });
}

function FriendsView({ host }: ViewProps) {
  const startDM = async (actorId: string) => {
    const res = await api.startDM(actorId);
    void res;
  };
  return createElement(FriendsPanel, {
    onStartDM: startDM,
    onClose: host.closeView,
  });
}

function MentionsView({ host }: ViewProps) {
  return createElement(MentionsPanel, {
    onClose: host.closeView,
  });
}

function ChannelSettingsView({ host, viewState }: ViewProps) {
  const channelId = viewState.channelId as string | undefined;
  const channel = channelId
    ? host.channels.find((c: { id: string }) => c.id === channelId)
    : null;
  if (!channel) return null;
  return createElement(ChannelSettingsPanel, {
    channel,
    onClose: host.closeView,
  });
}

function SettingsView({ host }: ViewProps) {
  return createElement(SettingsPanel, {
    actor: host.actor,
    onClose: host.closeView,
    onActorUpdate: host.onActorUpdate,
  });
}

export function registerBuiltinViews(): void {
  registerView({
    id: 'calendar',
    label: 'Calendar',
    icon: '📅',
    isAvailable: () => true,
    View: CalendarView,
  });

  registerView({
    id: 'wiki',
    label: 'Wiki',
    icon: '📖',
    isAvailable: (host) => host.selectedServer !== null,
    View: WikiView,
  });

  registerView({
    id: 'files',
    label: 'Files',
    icon: '📁',
    isAvailable: (host) => host.selectedServer !== null,
    View: FilesView,
  });

  registerView({
    id: 'manual',
    label: 'Manual',
    isAvailable: () => false,
    View: ManualView,
  });

  registerView({
    id: 'settings',
    label: 'Settings',
    icon: '⚙️',
    isAvailable: () => false,
    View: SettingsView,
  });

  registerView({
    id: 'server-settings',
    label: 'Server Settings',
    isAvailable: () => false,
    View: ServerSettingsView,
  });

  registerView({
    id: 'channel-settings',
    label: 'Channel Settings',
    isAvailable: () => false,
    View: ChannelSettingsView,
  });

  registerView({
    id: 'friends',
    label: 'Friends',
    icon: '👥',
    isAvailable: () => true,
    View: FriendsView,
  });

  registerView({
    id: 'mentions',
    label: 'Mentions',
    icon: '@',
    isAvailable: () => true,
    View: MentionsView,
  });
}
