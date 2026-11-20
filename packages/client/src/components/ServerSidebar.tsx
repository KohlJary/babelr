// SPDX-License-Identifier: MIT
import type { HouseMember, ServerView } from '@babelr/shared';
import { useT } from '../i18n/I18nProvider';

interface ServerSidebarProps {
  servers: ServerView[];
  selectedServerId: string | null;
  dmMode: boolean;
  onSelectServer: (id: string) => void;
  onSelectDMs: () => void;
  /** The House: its button, and the daemons who live here, on the rail. */
  houseActive?: boolean;
  houseMembers?: HouseMember[];
  onOpenHouse?: (member?: string) => void;
  onCreateServer: () => void;
  onOpenManual?: () => void;
}

export function ServerSidebar({
  servers,
  selectedServerId,
  dmMode,
  onSelectServer,
  onSelectDMs,
  houseActive = false,
  houseMembers = [],
  onOpenHouse,
  onCreateServer,
  onOpenManual,
}: ServerSidebarProps) {
  const t = useT();
  return (
    <div className="server-sidebar" data-tour="rail">
      {onOpenHouse && (
        <>
          <button
            className={`server-icon house-icon ${houseActive ? 'active' : ''}`}
            onClick={() => onOpenHouse()}
            title={t('serverSidebar.house')}
            aria-label={t('serverSidebar.house')}
          >
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path
                d="M3 11.5 12 4l9 7.5M5.5 9.5V20h13V9.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          {houseMembers.map((m) => (
            <button
              key={m.id}
              className="server-icon house-member-icon"
              onClick={() => onOpenHouse(m.preferredUsername)}
              title={
                m.now
                  ? `${m.displayName ?? m.preferredUsername}: ${m.now.text}`
                  : (m.displayName ?? m.preferredUsername)
              }
              aria-label={m.displayName ?? m.preferredUsername}
            >
              {m.avatarUrl ? (
                <img src={m.avatarUrl} alt="" className="server-icon-img" />
              ) : (
                (m.sigil ?? (m.displayName ?? m.preferredUsername).charAt(0)).toUpperCase()
              )}
              {m.now && <span className="house-member-live" aria-hidden="true" />}
            </button>
          ))}
          <div className="server-divider" />
        </>
      )}
      <button
        className={`server-icon dm-icon ${dmMode ? 'active' : ''}`}
        onClick={onSelectDMs}
        title={t('serverSidebar.directMessages')}
      >
        DM
      </button>
      <div className="server-divider" />
      {servers.map((server) => (
        <button
          key={server.id}
          className={`server-icon ${server.logoUrl ? 'has-logo' : ''} ${selectedServerId === server.id && !dmMode ? 'active' : ''}`}
          onClick={() => onSelectServer(server.id)}
          title={server.name}
        >
          {server.logoUrl ? (
            <img src={server.logoUrl} alt={server.name} className="server-icon-img" />
          ) : (
            server.name.charAt(0).toUpperCase()
          )}
        </button>
      ))}
      <button
        className="server-icon add-server"
        onClick={onCreateServer}
        title={t('serverSidebar.createServer')}
      >
        +
      </button>
      {onOpenManual && (
        <>
          <div className="server-divider" />
          <button
            className="server-icon manual-icon"
            onClick={onOpenManual}
            title={t('serverSidebar.manual')}
          >
            ?
          </button>
        </>
      )}
    </div>
  );
}
