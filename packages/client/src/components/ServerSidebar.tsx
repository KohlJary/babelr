// SPDX-License-Identifier: Hippocratic-3.0
import type { ServerView } from '@babelr/shared';
import { useT } from '../i18n/I18nProvider';

interface ServerSidebarProps {
  servers: ServerView[];
  selectedServerId: string | null;
  dmMode: boolean;
  onSelectServer: (id: string) => void;
  onSelectDMs: () => void;
  onCreateServer: () => void;
  onOpenManual?: () => void;
}

export function ServerSidebar({
  servers,
  selectedServerId,
  dmMode,
  onSelectServer,
  onSelectDMs,
  onCreateServer,
  onOpenManual,
}: ServerSidebarProps) {
  const t = useT();
  return (
    <div className="server-sidebar">
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
      <button className="server-icon add-server" onClick={onCreateServer} title={t('serverSidebar.createServer')}>
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
