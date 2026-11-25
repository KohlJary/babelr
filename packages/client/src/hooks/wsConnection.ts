// SPDX-License-Identifier: MIT
import type { WsServerMessage, WsClientMessage } from '@babelr/shared';

/**
 * One /ws connection per tab, shared by every useWebSocket caller.
 *
 * Each hook used to open its own socket, so a signed-in tab held six
 * or seven, the server pushed every broadcast once per socket, and
 * `babelr:ws` fired once per socket for plugins. Now hooks subscribe
 * here: the socket opens while at least one subscriber is enabled,
 * every message reaches each subscriber once, and `babelr:ws` fires
 * once per message.
 *
 * Channel subscriptions are reference-counted: several components can
 * follow the same channel (ChatView, a wiki or file panel), and one of
 * them unmounting must not unsubscribe the socket the others share.
 */

const MAX_RECONNECT_DELAY = 30_000;
const INITIAL_RECONNECT_DELAY = 1000;

type MessageHandler = (msg: WsServerMessage) => void;
type ConnectedHandler = (connected: boolean) => void;

interface SocketLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface WsConnectionOptions {
  createSocket?: () => SocketLike;
  /** Re-dispatch target for `babelr:ws`; null to skip. */
  eventTarget?: { dispatchEvent(ev: Event): boolean } | null;
}

const OPEN = 1;

function defaultSocket(): SocketLike {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return new WebSocket(`${protocol}//${location.host}/ws`) as unknown as SocketLike;
}

export function createWsConnection(opts: WsConnectionOptions = {}) {
  const createSocket = opts.createSocket ?? defaultSocket;
  const eventTarget =
    opts.eventTarget !== undefined
      ? opts.eventTarget
      : typeof window !== 'undefined'
        ? window
        : null;

  const messageHandlers = new Set<MessageHandler>();
  const connectedHandlers = new Set<ConnectedHandler>();
  const channelRefs = new Map<string, number>();
  let enabledCount = 0;
  let socket: SocketLike | null = null;
  let connected = false;
  let reconnectDelay = INITIAL_RECONNECT_DELAY;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  function setConnected(value: boolean) {
    if (connected === value) return;
    connected = value;
    for (const h of [...connectedHandlers]) h(value);
  }

  function connect() {
    if (socket || enabledCount === 0) return;
    const ws = createSocket();
    socket = ws;

    ws.onopen = () => {
      if (socket !== ws) return;
      reconnectDelay = INITIAL_RECONNECT_DELAY;
      setConnected(true);
    };

    ws.onmessage = (event) => {
      if (socket !== ws) return;
      let msg: WsServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as WsServerMessage;
      } catch {
        return; // Ignore malformed messages
      }
      for (const h of [...messageHandlers]) {
        try {
          h(msg);
        } catch (err) {
          console.error('[ws] handler failed', err);
        }
      }
      // Re-dispatch as a DOM custom event so plugins can subscribe to
      // their own namespaced messages (plugin:<id>:<event>) without
      // plumbing through the core handler pipeline.
      if (eventTarget && typeof CustomEvent !== 'undefined') {
        eventTarget.dispatchEvent(new CustomEvent('babelr:ws', { detail: msg }));
      }
    };

    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      // The server forgets this socket's channel subscriptions; callers
      // re-subscribe when `connected` comes back, so start the counts over.
      channelRefs.clear();
      setConnected(false);
      if (enabledCount === 0) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
        connect();
      }, reconnectDelay);
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  function disconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const ws = socket;
    socket = null;
    channelRefs.clear();
    reconnectDelay = INITIAL_RECONNECT_DELAY;
    if (ws) ws.close();
    setConnected(false);
  }

  /** Hold the connection open. Returns the release function. */
  function acquire(): () => void {
    enabledCount++;
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    // A new holder (e.g. right after login) shouldn't wait out a backoff
    // left by an earlier unauthenticated attempt.
    if (!socket) {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnectDelay = INITIAL_RECONNECT_DELAY;
      connect();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      enabledCount--;
      if (enabledCount > 0) return;
      // Defer the close so a release/acquire pair in the same tick
      // (React StrictMode, a remount) keeps the socket instead of
      // closing it before it connects.
      if (closeTimer) clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        closeTimer = null;
        if (enabledCount === 0) disconnect();
      }, 0);
    };
  }

  function rawSend(msg: WsClientMessage) {
    if (socket && socket.readyState === OPEN) socket.send(JSON.stringify(msg));
  }

  function send(msg: WsClientMessage) {
    if (msg.type === 'channel:subscribe') {
      if (!socket || socket.readyState !== OPEN) return;
      const id = msg.payload.channelId;
      channelRefs.set(id, (channelRefs.get(id) ?? 0) + 1);
      rawSend(msg);
      return;
    }
    if (msg.type === 'channel:unsubscribe') {
      const id = msg.payload.channelId;
      const n = channelRefs.get(id) ?? 0;
      if (n > 1) {
        channelRefs.set(id, n - 1);
        return;
      }
      channelRefs.delete(id);
      if (n === 1) rawSend(msg);
      return;
    }
    rawSend(msg);
  }

  function onMessage(h: MessageHandler): () => void {
    messageHandlers.add(h);
    return () => messageHandlers.delete(h);
  }

  function onConnected(h: ConnectedHandler): () => void {
    connectedHandlers.add(h);
    return () => connectedHandlers.delete(h);
  }

  return {
    acquire,
    send,
    onMessage,
    onConnected,
    isConnected: () => connected,
  };
}

export type WsConnection = ReturnType<typeof createWsConnection>;

let shared: WsConnection | null = null;

/** The tab's one shared connection. */
export function getWsConnection(): WsConnection {
  if (!shared) shared = createWsConnection();
  return shared;
}
