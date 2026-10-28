// SPDX-License-Identifier: Hippocratic-3.0
import { useEffect, useState } from 'react';
import type { AgentReplyStatusView } from '@babelr/shared';
import { useT } from '../i18n/I18nProvider';

/**
 * A reply that's been "working" this long without a word has most
 * likely died (the agent crashed, or its host restarted): show it as
 * stalled and offer Retry. Long enough for a slow model to finish.
 */
export const STALE_MS = 10 * 60 * 1000;

interface Props {
  statuses: AgentReplyStatusView[];
  /** Present when the viewer wrote the message, so may ask for a retry. */
  onRetry?: (agentId: string) => Promise<void>;
}

/** Under a message: which agents are answering it, and how it's going. */
export function AgentStatusLine({ statuses, onRetry }: Props) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = statuses.filter((s) => s.state !== 'done');
  const waiting = live.some((s) => s.state === 'working' || s.state === 'retry');

  // Re-render once a minute while something's pending, so a reply
  // that goes quiet turns into "stopped replying" without a reload.
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [waiting]);

  if (live.length === 0) return null;

  return (
    <div className="agent-status" role="status">
      {live.map((s) => {
        const name = s.agent.displayName ?? s.agent.preferredUsername;
        const stale = now - new Date(s.updatedAt).getTime() > STALE_MS;
        const failed = s.state === 'failed';
        const stalled = !failed && stale;
        const label = failed
          ? t('messages.agentFailed', { name })
          : stalled
            ? t('messages.agentStalled', { name })
            : s.state === 'retry'
              ? t('messages.agentRetrying', { name })
              : t('messages.agentWorking', { name });
        const canRetry = onRetry && (failed || stalled);
        return (
          <div
            key={s.agent.id}
            className={`agent-status-row ${failed || stalled ? 'agent-status-problem' : 'agent-status-pending'}`}
          >
            {!failed && !stalled && <span className="agent-status-dot" aria-hidden="true" />}
            <span className="agent-status-label">{label}</span>
            {failed && s.detail && <span className="agent-status-detail">({s.detail})</span>}
            {canRetry && (
              <button
                type="button"
                className="agent-status-retry"
                disabled={busy === s.agent.id}
                onClick={async () => {
                  setBusy(s.agent.id);
                  setError(null);
                  try {
                    await onRetry(s.agent.id);
                  } catch (err) {
                    setError(t('messages.agentRetryFailed', { error: (err as Error).message }));
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {t('messages.agentRetry')}
              </button>
            )}
          </div>
        );
      })}
      {error && <div className="agent-status-error">{error}</div>}
    </div>
  );
}
