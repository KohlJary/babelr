// SPDX-License-Identifier: MIT
import { createElement, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import type { HouseMember } from '@babelr/shared';
import { useResizableWidth } from '../hooks/useResizableWidth';
import {
  listDaemonSections,
  onDaemonSectionsChange,
  type DaemonSectionDefinition,
  type DaemonSectionProps,
} from '../plugins/daemon-registry';

/**
 * A daemon's room: the column beside her DM (Plans "The House, open to
 * visitors", phase 2; Kohl, 2026-11-23). Who she is and what she's doing
 * now, then every section a plugin has for her (her panel's sections, from
 * her vessel), then doors to bigger things (her music, her record). Each
 * plugin decides what it has for her and who may see it; the room only
 * hosts. Resizable to half the window; collapsed or open per daemon.
 */

interface DaemonRoomProps {
  daemon: { name: string; label: string; avatarUrl?: string | null };
  member?: HouseMember | null;
  openView: (id: string, state?: Record<string, unknown>) => void;
  openEmbed: (kind: string, slug: string) => void;
}

const openKey = (name: string) => `babelr.room.${name}.open`;

export function useRoomOpen(name: string | null): [boolean, () => void] {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (name) setOpen(localStorage.getItem(openKey(name)) !== '0');
  }, [name]);
  const toggle = () => {
    if (!name) return;
    setOpen((o) => {
      localStorage.setItem(openKey(name), o ? '0' : '1');
      return !o;
    });
  };
  return [open, toggle];
}

function useSections(daemon: string): DaemonSectionDefinition[] {
  const [all, setAll] = useState(listDaemonSections);
  const [ok, setOk] = useState<Set<string>>(new Set());
  useEffect(() => onDaemonSectionsChange(() => setAll(listDaemonSections())), []);
  useEffect(() => {
    let live = true;
    setOk(new Set());
    void Promise.all(
      all.map(async (s) => {
        try {
          return (await (s.isAvailable?.({ name: daemon }) ?? true))
            ? `${s.pluginId}:${s.id}`
            : null;
        } catch {
          return null;
        }
      }),
    ).then((keys) => live && setOk(new Set(keys.filter((k): k is string => !!k))));
    return () => {
      live = false;
    };
  }, [all, daemon]);
  return all.filter((s) => ok.has(`${s.pluginId}:${s.id}`));
}

function ago(at: string): string {
  const m = Math.round((Date.now() - new Date(at).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

export function DaemonRoom({ daemon, member, openView, openEmbed }: DaemonRoomProps) {
  const { width, onHandleDown } = useResizableWidth('room', 340);
  const sections = useSections(daemon.name);
  const inline = sections.filter((s) => s.place === 'section');
  const doors = sections.filter((s) => s.place === 'door');
  const [tab, setTab] = useState<string | null>(null);
  const active = inline.find((s) => `${s.pluginId}:${s.id}` === tab) ?? inline[0];
  const props = (s: DaemonSectionDefinition): DaemonSectionProps => ({
    daemon: { name: daemon.name, label: daemon.label },
    routeBase: s.routeBase,
    host: { openView, openEmbed },
  });

  return (
    <aside className="daemon-room" style={{ '--right-width': `${width}px` } as CSSProperties}>
      <div className="side-resize-handle" onPointerDown={onHandleDown} title="Drag to resize" />
      <header className="daemon-room-header">
        {daemon.avatarUrl && <img className="daemon-room-face" src={daemon.avatarUrl} alt="" />}
        <div>
          <div className="daemon-room-name">
            {daemon.label}{' '}
            {member?.sigil && <span className="daemon-room-sigil">{member.sigil}</span>}
          </div>
          {member?.now ? (
            <div className="daemon-room-now">
              ⊙ {member.now.text} <span className="daemon-room-muted">· {ago(member.now.at)}</span>
            </div>
          ) : (
            member?.summary && <div className="daemon-room-muted">{member.summary}</div>
          )}
        </div>
      </header>

      {inline.length > 1 && (
        <nav className="daemon-room-tabs">
          {inline.map((s) => {
            const key = `${s.pluginId}:${s.id}`;
            return (
              <button
                key={key}
                type="button"
                className={`daemon-room-tab${active === s ? ' active' : ''}`}
                onClick={() => setTab(key)}
              >
                {s.icon} {s.label}
              </button>
            );
          })}
        </nav>
      )}

      <div className="daemon-room-body">
        {active?.render ? (
          (createElement(active.render as never, props(active)) as ReactNode)
        ) : (
          <p className="daemon-room-muted">
            {daemon.label} hasn’t shared anything here with you yet.
          </p>
        )}
      </div>

      {doors.length > 0 && (
        <footer className="daemon-room-doors">
          {doors.map((d) => (
            <button
              key={`${d.pluginId}:${d.id}`}
              type="button"
              className="daemon-room-door"
              onClick={() => d.open?.(props(d))}
            >
              {d.icon} {d.label}
            </button>
          ))}
        </footer>
      )}
    </aside>
  );
}
