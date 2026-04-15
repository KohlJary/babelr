// SPDX-License-Identifier: Hippocratic-3.0

/**
 * Subscribe to plugin-namespaced WS messages. Abstracts the
 * window.addEventListener('babelr:ws', ...) + CustomEvent.detail +
 * type-filter dance every real-time plugin was duplicating.
 *
 * Typical usage inside a plugin's client module:
 *
 *   const unsub = onWsMessage<PollPayload>(
 *     'plugin:polls:updated',
 *     (payload) => publishUpdate(payload),
 *   );
 *   // ... later, on teardown
 *   unsub();
 *
 * The `type` argument matches against the WS message's `type` field
 * verbatim. Plugin authors conventionally namespace with
 * `plugin:<id>:<event>` so messages don't collide with core types
 * and don't require first-party WS message type additions.
 */
export function onWsMessage<TPayload = unknown>(
  type: string,
  handler: (payload: TPayload) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};
  const listener = (ev: Event) => {
    const msg = (ev as CustomEvent).detail as { type?: string; payload?: unknown };
    if (msg?.type === type) {
      handler(msg.payload as TPayload);
    }
  };
  window.addEventListener('babelr:ws', listener);
  return () => window.removeEventListener('babelr:ws', listener);
}
