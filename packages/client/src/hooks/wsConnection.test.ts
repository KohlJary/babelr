// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { WsServerMessage } from '@babelr/shared';
import { createWsConnection } from './wsConnection';

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor() {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({});
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(msg: WsServerMessage) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const presence: WsServerMessage = {
  type: 'presence:update',
  payload: { actorId: 'a1', status: 'online' },
};

function setup() {
  const target = new EventTarget();
  const conn = createWsConnection({
    createSocket: () => new FakeSocket(),
    eventTarget: target,
  });
  return { conn, target };
}

beforeEach(() => {
  FakeSocket.all = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('shared WebSocket connection', () => {
  it('opens one socket for many holders and delivers each message to each subscriber once', () => {
    const { conn, target } = setup();
    const got: string[] = [];
    let wsEvents = 0;
    target.addEventListener('babelr:ws', () => wsEvents++);
    for (let i = 0; i < 7; i++) {
      conn.onMessage(() => got.push(`h${i}`));
      conn.acquire();
    }
    expect(FakeSocket.all).toHaveLength(1);
    FakeSocket.all[0].open();
    FakeSocket.all[0].receive(presence);
    expect(got).toEqual(['h0', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
    expect(wsEvents).toBe(1);
  });

  it('reports connected to subscribers and closes only after the last holder releases', () => {
    const { conn } = setup();
    const states: boolean[] = [];
    conn.onConnected((c) => states.push(c));
    const r1 = conn.acquire();
    const r2 = conn.acquire();
    FakeSocket.all[0].open();
    expect(conn.isConnected()).toBe(true);
    r1();
    vi.runAllTimers();
    expect(FakeSocket.all[0].closed).toBe(false);
    r2();
    vi.runAllTimers();
    expect(FakeSocket.all[0].closed).toBe(true);
    expect(states).toEqual([true, false]);
    // No reconnect once nobody holds it.
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('keeps the socket across a release/acquire in the same tick (StrictMode remount)', () => {
    const { conn } = setup();
    const release = conn.acquire();
    release();
    conn.acquire();
    vi.runAllTimers();
    expect(FakeSocket.all).toHaveLength(1);
    expect(FakeSocket.all[0].closed).toBe(false);
  });

  it('reconnects with backoff while held, and a new holder skips the wait', () => {
    const { conn } = setup();
    conn.acquire();
    FakeSocket.all[0].open();
    FakeSocket.all[0].close();
    expect(conn.isConnected()).toBe(false);
    vi.advanceTimersByTime(999);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1].close(); // e.g. 4001 before login
    conn.acquire(); // a hook enabled after login
    expect(FakeSocket.all).toHaveLength(3);
  });

  it('reference-counts channel subscriptions across callers', () => {
    const { conn } = setup();
    conn.acquire();
    const ws = FakeSocket.all[0];
    ws.open();
    const sub = { type: 'channel:subscribe', payload: { channelId: 'c1' } } as const;
    const unsub = { type: 'channel:unsubscribe', payload: { channelId: 'c1' } } as const;
    conn.send(sub);
    conn.send(sub);
    conn.send(unsub);
    expect(ws.sent.filter((m) => (m as { type: string }).type === 'channel:unsubscribe')).toEqual(
      [],
    );
    conn.send(unsub);
    expect(ws.sent).toEqual([sub, sub, unsub]);
    // A stray extra unsubscribe isn't forwarded.
    conn.send(unsub);
    expect(ws.sent).toHaveLength(3);
  });

  it('starts channel counts over after a reconnect', () => {
    const { conn } = setup();
    conn.acquire();
    FakeSocket.all[0].open();
    conn.send({ type: 'channel:subscribe', payload: { channelId: 'c1' } });
    FakeSocket.all[0].close();
    // The hook's cleanup runs while disconnected: dropped, not counted.
    conn.send({ type: 'channel:unsubscribe', payload: { channelId: 'c1' } });
    vi.advanceTimersByTime(1000);
    const ws2 = FakeSocket.all[1];
    ws2.open();
    conn.send({ type: 'channel:subscribe', payload: { channelId: 'c1' } });
    conn.send({ type: 'channel:unsubscribe', payload: { channelId: 'c1' } });
    expect(ws2.sent).toEqual([
      { type: 'channel:subscribe', payload: { channelId: 'c1' } },
      { type: 'channel:unsubscribe', payload: { channelId: 'c1' } },
    ]);
  });

  it('drops sends while not open', () => {
    const { conn } = setup();
    conn.acquire();
    conn.send({ type: 'presence:heartbeat', payload: {} });
    expect(FakeSocket.all[0].sent).toEqual([]);
  });
});
