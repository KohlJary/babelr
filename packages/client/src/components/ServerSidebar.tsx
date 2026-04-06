// SPDX-License-Identifier: Hippocratic-3.0
import type { ServerView } from '@babelr/shared';

interface ServerSidebarProps {
  servers: ServerView[];
  selectedServerId: string | null;
  dmMode: boolean;
  onSelectServer: (id: string) => void;
  onSelectDMs: () => void;
  onCreateServer: () => void;
}

export function ServerSidebar({
  servers,
  selectedServerId,
  dmMode,
  onSelectServer,
  onSelectDMs,
  onCreateServer,
}: ServerSidebarProps) {
  return (
    <div className="server-sidebar">
      <button
        className={`server-icon dm-icon ${dmMode ? 'active' : ''}`}
        onClick={onSelectDMs}
        title="Direct Messages"
      >
        DM
      </button>
      <div className="server-divider" />
      {servers.map((server) => (
        <button
          key={server.id}
          className={`server-icon ${selectedServerId === server.id && !dmMode ? 'active' : ''}`}
          onClick={() => onSelectServer(server.id)}
          title={server.name}
        >
          {server.name.charAt(0).toUpperCase()}
        </button>
      ))}
      <button className="server-icon add-server" onClick={onCreateServer} title="Create server">
        +
      </button>
    </div>
  );
}
