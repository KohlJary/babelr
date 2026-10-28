// SPDX-License-Identifier: Hippocratic-3.0
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type {
  AnswerRating,
  BlindBundle,
  BlindRoundPayload,
  BlindResults,
  BlindRoundSummary,
  BlindRubricField,
  RatingValue,
} from './manifest.js';

/**
 * Client components for the blinds plugin. Same split as polls:
 * setupClient lazy-imports this module so React stays out of the
 * server's import graph.
 *
 * Differences from polls, on purpose:
 *   - No WS subscription and no shared cross-component cache of
 *     ratings: the server never broadcasts, and each grader sees only
 *     their own.
 *   - Answer and prompt text render raw. Polls wraps labels in <T>,
 *     which sends text to the translation pipeline; blinded answers
 *     must not be reworded or sent anywhere.
 *   - Inline card shows progress only (n of m graded), never ratings,
 *     so a message carrying [[blind:round]] reveals nothing even to the
 *     grader's onlookers.
 */

interface RoundProps {
  slug: string;
  routeBase: string;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'forbidden' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; data: BlindRoundPayload };

async function fetchRound(slug: string, routeBase: string): Promise<LoadState> {
  try {
    const res = await fetch(`${routeBase}/rounds/${encodeURIComponent(slug)}`, {
      credentials: 'include',
      cache: 'no-store',
    });
    if (res.status === 403) return { kind: 'forbidden' };
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { kind: 'error', message: body.error ?? res.statusText };
    }
    return { kind: 'ok', data: (await res.json()) as BlindRoundPayload };
  } catch (err) {
    return { kind: 'error', message: (err as Error).message };
  }
}

/**
 * Local-only change signal: when the grader saves, inline cards for
 * the same round in this tab refetch their progress. In-tab only, no
 * WS: nothing about grading leaves the grader's own requests.
 */
const changeListeners = new Map<string, Set<() => void>>();
function onRoundChanged(slug: string, fn: () => void): () => void {
  let set = changeListeners.get(slug);
  if (!set) changeListeners.set(slug, (set = new Set()));
  set.add(fn);
  return () => set!.delete(fn);
}
function roundChanged(slug: string) {
  changeListeners.get(slug)?.forEach((fn) => fn());
}

function useRound(slug: string, routeBase: string, follow = false) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const reload = useCallback(async () => {
    setState(await fetchRound(slug, routeBase));
  }, [slug, routeBase]);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      void fetchRound(slug, routeBase).then((s) => {
        if (!cancelled) setState(s);
      });
    load();
    const off = follow ? onRoundChanged(slug, load) : undefined;
    return () => {
      cancelled = true;
      off?.();
    };
  }, [slug, routeBase, follow]);
  return { state, setState, reload };
}

function isGraded(bundle: BlindBundle, r: AnswerRating | undefined): boolean {
  return !!r && bundle.rubric.every((f) => r.fields[f.id] !== undefined);
}

function countGraded(bundle: BlindBundle, ratings: Record<string, AnswerRating>): number {
  return bundle.answers.filter((a) => isGraded(bundle, ratings[a.label])).length;
}

// ── Inline card ──────────────────────────────────────────────────────

export function BlindInline(props: Record<string, unknown>) {
  const { slug, routeBase, onClick } = props as unknown as RoundProps & { onClick: () => void };
  const { state } = useRound(slug, routeBase, true);
  if (state.kind === 'loading') {
    return (
      <button type="button" className="poll-embed loading" onClick={onClick}>
        Loading blind round…
      </button>
    );
  }
  if (state.kind !== 'ok') {
    return (
      <span className="poll-embed blind-embed-locked">
        <span className="poll-embed-body">
          <span className="poll-embed-question">Blind round</span>
          <span className="poll-embed-meta">
            {state.kind === 'forbidden' ? 'Grader only' : 'Unavailable'}
          </span>
        </span>
      </span>
    );
  }
  const { data } = state;
  const pct = data.total ? Math.round((data.graded / data.total) * 100) : 0;
  return (
    <button
      type="button"
      className="poll-embed ok blind-embed"
      onClick={onClick}
      aria-label={`Blind round ${data.bundle.title}: ${data.graded} of ${data.total} graded${data.lockedAt ? ', locked' : ''}. Open to grade.`}
    >
      <span className="poll-embed-body">
        <span className="poll-embed-question">{data.bundle.title}</span>
        <span className="poll-embed-meta">
          {data.graded} of {data.total} graded
          {data.lockedAt ? ' · locked' : ''}
        </span>
        <span className="blind-progress" aria-hidden="true">
          <span className="blind-progress-bar" style={{ width: `${pct}%` }} />
        </span>
      </span>
    </button>
  );
}

// ── Grader ───────────────────────────────────────────────────────────

async function api<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(b.error ?? res.statusText);
  }
  return (await res.json()) as T;
}

interface FieldControlProps {
  field: BlindRubricField;
  value: RatingValue | undefined;
  disabled: boolean;
  onChange: (v: RatingValue | null) => void;
}

/** One rubric field as a native radio group styled as segmented
 *  buttons: arrow keys, labels and the group legend come for free. A
 *  bool is a No/Yes toggle; unset stays visibly unset. */
function FieldControl({ field, value, disabled, onChange }: FieldControlProps) {
  const name = useId();
  const helpId = useId();
  const options: Array<{ v: RatingValue; label: string }> =
    field.type === 'bool'
      ? [
          { v: false, label: 'No' },
          { v: true, label: 'Yes' },
        ]
      : Array.from({ length: field.max! - field.min! + 1 }, (_, i) => ({
          v: field.min! + i,
          label: String(field.min! + i),
        }));
  return (
    <fieldset className="blind-field" aria-describedby={field.help ? helpId : undefined}>
      <legend className="blind-field-label">{field.label}</legend>
      {field.help && (
        <p id={helpId} className="blind-field-help">
          {field.help}
        </p>
      )}
      <div className="blind-segmented">
        {options.map((o) => {
          const id = `${name}-${String(o.v)}`;
          return (
            <span key={String(o.v)} className="blind-segment">
              <input
                type="radio"
                id={id}
                name={name}
                checked={value === o.v}
                disabled={disabled}
                onChange={() => onChange(o.v)}
              />
              <label htmlFor={id}>{o.label}</label>
            </span>
          );
        })}
        {value !== undefined && !disabled && (
          <button
            type="button"
            className="blind-clear"
            onClick={() => onChange(null)}
            aria-label={`Clear ${field.label}`}
          >
            Clear
          </button>
        )}
      </div>
    </fieldset>
  );
}

interface RankStepProps {
  bundle: BlindBundle;
  ranks: Record<string, string[]>;
  locked: boolean;
  onSave: (promptId: string, order: string[]) => void;
}

function RankStep({ bundle, ranks, locked, onSave }: RankStepProps) {
  return (
    <section className="blind-rank" aria-labelledby="blind-rank-title">
      <h3 id="blind-rank-title" tabIndex={-1} className="blind-step-title">
        Rank the answers
      </h3>
      <p className="blind-field-help">Best first, per prompt. Use the arrows to move an answer.</p>
      {bundle.prompts.map((p) => {
        const labels = bundle.answers.filter((a) => a.prompt_id === p.id).map((a) => a.label);
        const saved = ranks[p.id];
        const order = saved && saved.length === labels.length ? saved : labels;
        const move = (i: number, d: number) => {
          const next = [...order];
          [next[i], next[i + d]] = [next[i + d], next[i]];
          onSave(p.id, next);
          // Keep focus on the moved answer: its button in the direction
          // of travel, or the other one if it just hit the end.
          requestAnimationFrame(() => {
            const btns = document.querySelectorAll<HTMLButtonElement>(
              `[data-rank-label="${CSS.escape(next[i + d])}"]`,
            );
            const want = Array.from(btns).find((b) => b.dataset.dir === (d < 0 ? 'up' : 'down'));
            (want && !want.disabled ? want : Array.from(btns).find((b) => !b.disabled))?.focus();
          });
        };
        return (
          <div key={p.id} className="blind-rank-prompt">
            <h4>
              {p.id}
              {!saved && <span className="blind-badge">unranked</span>}
            </h4>
            <p className="blind-rank-prompt-text">{p.text}</p>
            <ol className="blind-rank-list">
              {order.map((label, i) => {
                const a = bundle.answers.find((x) => x.label === label)!;
                return (
                  <li key={label} className="blind-rank-item">
                    <span className="blind-rank-label">{label}</span>
                    {/* Re-read while ranking: the full answer opens in place. */}
                    <details className="blind-rank-answer">
                      <summary className="blind-rank-snippet">
                        {a.text.length > 90 ? `${a.text.slice(0, 90)}…` : a.text}
                      </summary>
                      <div className="blind-rank-full">{a.text}</div>
                    </details>
                    <span className="blind-rank-buttons">
                      <button
                        type="button"
                        disabled={locked || i === 0}
                        data-rank-label={label}
                        data-dir="up"
                        onClick={() => move(i, -1)}
                        aria-label={`Move ${label} up`}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        disabled={locked || i === order.length - 1}
                        data-rank-label={label}
                        data-dir="down"
                        onClick={() => move(i, 1)}
                        aria-label={`Move ${label} down`}
                      >
                        ↓
                      </button>
                    </span>
                  </li>
                );
              })}
            </ol>
            {!saved && !locked && (
              <button type="button" className="blind-secondary" onClick={() => onSave(p.id, order)}>
                Keep this order
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}

export function BlindGrader(props: Record<string, unknown>) {
  const { slug, routeBase } = props as unknown as RoundProps;
  const { state, setState, reload } = useRound(slug, routeBase);
  const [index, setIndex] = useState(0);
  const [step, setStep] = useState<'grade' | 'rank' | 'lock'>('grade');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteId = useId();

  const data = state.kind === 'ok' ? state.data : null;
  const answer = data?.bundle.answers[index];
  const savedNote = answer ? (data?.ratings[answer.label]?.note ?? '') : '';

  // Reset the note draft when the answer changes.
  useEffect(() => {
    setNoteDraft(savedNote);
  }, [answer?.label]); // savedNote deliberately omitted: only reset on answer change

  // Move focus to the step's heading on navigation so screen readers
  // announce the new answer and keyboard order restarts at the top.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (step === 'grade') headingRef.current?.focus();
    else
      document.getElementById(step === 'rank' ? 'blind-rank-title' : 'blind-lock-title')?.focus();
  }, [index, step]);

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  // Optimistic: the control reflects a tap immediately, and the
  // response body is not applied (two quick taps could answer out of
  // order). On a failed save, refetch so the screen shows what's stored.
  const applyLocal = useCallback(
    (label: string, body: Record<string, unknown>) => {
      setState((s) => {
        if (s.kind !== 'ok') return s;
        const prev = s.data.ratings[label] ?? { fields: {}, note: '' };
        const next: AnswerRating = { fields: { ...prev.fields }, note: prev.note };
        if (typeof body.field === 'string') {
          if (body.value === null) delete next.fields[body.field];
          else next.fields[body.field] = body.value as RatingValue;
        }
        if (typeof body.note === 'string') next.note = body.note;
        const ratings = { ...s.data.ratings, [label]: next };
        return {
          kind: 'ok',
          data: { ...s.data, ratings, graded: countGraded(s.data.bundle, ratings) },
        };
      });
    },
    [setState],
  );

  const save = useCallback(
    async (label: string, body: Record<string, unknown>) => {
      setStatus('Saving…');
      setError(null);
      applyLocal(label, body);
      try {
        await api(
          `${routeBase}/rounds/${encodeURIComponent(slug)}/ratings/${encodeURIComponent(label)}`,
          'PUT',
          body,
        );
        setStatus('Saved');
        roundChanged(slug);
      } catch (err) {
        setStatus('');
        setError(`Not saved: ${(err as Error).message}`);
        await reload();
      }
    },
    [routeBase, slug, applyLocal, reload],
  );

  const flushNote = useCallback(() => {
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = null;
    if (answer && noteDraft !== savedNote) void save(answer.label, { note: noteDraft });
  }, [answer, noteDraft, savedNote, save]);

  const go = (next: number) => {
    flushNote();
    setConfirming(false);
    if (!data) return;
    const n = data.bundle.answers.length;
    if (next >= n) {
      setStep(data.bundle.rank ? 'rank' : 'lock');
      return;
    }
    setStep('grade');
    setIndex(Math.max(0, next));
  };

  const saveRank = async (promptId: string, order: string[]) => {
    setStatus('Saving…');
    setError(null);
    setState((s) =>
      s.kind === 'ok'
        ? { kind: 'ok', data: { ...s.data, ranks: { ...s.data.ranks, [promptId]: order } } }
        : s,
    );
    try {
      await api(
        `${routeBase}/rounds/${encodeURIComponent(slug)}/ranks/${encodeURIComponent(promptId)}`,
        'PUT',
        {
          order,
        },
      );
      setStatus('Saved');
    } catch (err) {
      setStatus('');
      setError(`Not saved: ${(err as Error).message}`);
      await reload();
    }
  };

  // A round opened after it was locked goes straight to its results.
  const jumpedToLock = useRef(false);
  useEffect(() => {
    if (data?.lockedAt && !jumpedToLock.current) {
      jumpedToLock.current = true;
      setStep('lock');
    }
  }, [data?.lockedAt]);

  // While an unblind is asked for and the scores aren't back (or came
  // back with an error the producer will retry), check every 5 seconds.
  const unblind = data?.unblind;
  const waiting = !!unblind?.requested && (!unblind.results || !!unblind.results.error);
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(() => void reload(), 5000);
    return () => clearInterval(id);
  }, [waiting, reload]);

  const requestUnblind = async () => {
    setError(null);
    try {
      await api(`${routeBase}/rounds/${encodeURIComponent(slug)}/unblind`, 'POST');
      await reload();
    } catch (err) {
      setError(`Unblind failed: ${(err as Error).message}`);
    }
  };

  const lock = async () => {
    setError(null);
    try {
      const res = await api<{ file: string }>(
        `${routeBase}/rounds/${encodeURIComponent(slug)}/lock`,
        'POST',
      );
      setConfirming(false);
      setStatus(`Round locked. ${res.file} exported.`);
      await reload();
      roundChanged(slug);
    } catch (err) {
      setError(`Lock failed: ${(err as Error).message}`);
    }
  };

  if (state.kind === 'loading') return <div className="poll-preview-loading">Loading round…</div>;
  if (state.kind === 'forbidden') {
    return <div className="poll-preview-error">This round is visible to its graders only.</div>;
  }
  if (state.kind === 'error') return <div className="poll-preview-error">{state.message}</div>;

  const { bundle, ratings, ranks } = state.data;
  const locked = !!state.data.lockedAt;
  const total = bundle.answers.length;
  const graded = countGraded(bundle, ratings);
  const rankedPrompts = bundle.prompts.filter((p) => ranks[p.id]).length;

  return (
    <div className="blind-grader">
      <header className="blind-header">
        <h2 className="poll-preview-question">{bundle.title}</h2>
        <div className="blind-header-meta">
          <span>
            {graded} of {total} graded
          </span>
          {locked && <span className="poll-preview-closed-badge">Locked</span>}
        </div>
        <div
          className="blind-progress"
          role="progressbar"
          aria-label="Answers graded"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={graded}
        >
          <span
            className="blind-progress-bar"
            style={{ width: `${total ? (graded / total) * 100 : 0}%` }}
          />
        </div>
        <label className="blind-jump">
          <span>Jump to</span>
          <select
            value={step === 'grade' ? String(index) : step}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'rank' || v === 'lock') {
                flushNote();
                setStep(v);
              } else go(Number(v));
            }}
          >
            {bundle.answers.map((a, i) => (
              <option key={a.label} value={i}>
                {a.label}
                {isGraded(bundle, ratings[a.label]) ? ' ✓' : ''}
              </option>
            ))}
            {bundle.rank && <option value="rank">Rank</option>}
            <option value="lock">Finish</option>
          </select>
        </label>
      </header>

      {step === 'grade' && answer && (
        <section className="blind-answer" aria-labelledby="blind-answer-title">
          <div className="blind-prompt">
            <span className="blind-prompt-id">
              Prompt {bundle.prompts.find((p) => p.id === answer.prompt_id)?.id}
            </span>
            <p className="blind-prompt-text">
              {bundle.prompts.find((p) => p.id === answer.prompt_id)?.text}
            </p>
          </div>
          <h3 id="blind-answer-title" ref={headingRef} tabIndex={-1} className="blind-step-title">
            Answer {answer.label}{' '}
            <span className="blind-count">
              ({index + 1} of {total})
            </span>
          </h3>
          <div className="blind-answer-text">{answer.text}</div>

          <div className="blind-rubric">
            {bundle.rubric.map((f) => (
              <FieldControl
                key={`${answer.label}-${f.id}`}
                field={f}
                value={ratings[answer.label]?.fields[f.id]}
                disabled={locked}
                onChange={(v) => void save(answer.label, { field: f.id, value: v })}
              />
            ))}
          </div>

          <div className="blind-note">
            <label htmlFor={noteId} className="blind-field-label">
              Note <span className="blind-optional">(optional)</span>
            </label>
            <textarea
              id={noteId}
              rows={3}
              value={noteDraft}
              disabled={locked}
              maxLength={4000}
              onChange={(e) => {
                setNoteDraft(e.target.value);
                if (noteTimer.current) clearTimeout(noteTimer.current);
                const text = e.target.value;
                const label = answer.label;
                noteTimer.current = setTimeout(() => void save(label, { note: text }), 800);
              }}
              onBlur={flushNote}
            />
          </div>
        </section>
      )}

      {step === 'rank' && (
        <RankStep
          bundle={bundle}
          ranks={ranks}
          locked={locked}
          onSave={(p, o) => void saveRank(p, o)}
        />
      )}

      {step === 'lock' && (
        <section className="blind-lock" aria-labelledby="blind-lock-title">
          <h3 id="blind-lock-title" tabIndex={-1} className="blind-step-title">
            {locked ? 'Locked' : 'Finish'}
          </h3>
          {locked ? (
            <>
              <p>Locked {new Date(state.data.lockedAt!).toLocaleString()}.</p>
              <UnblindPanel
                bundle={bundle}
                requested={!!state.data.unblind?.requested}
                results={state.data.unblind?.results ?? null}
                onRequest={() => void requestUnblind()}
              />
            </>
          ) : (
            <>
              <p>
                {graded} of {total} answers fully graded
                {bundle.rank ? `, ${rankedPrompts} of ${bundle.prompts.length} prompts ranked` : ''}
                .
              </p>
              {(graded < total || (bundle.rank && rankedPrompts < bundle.prompts.length)) && (
                <p className="blind-warning">
                  Some answers are not finished. They'll export as-is.
                </p>
              )}
              {!confirming ? (
                <button
                  type="button"
                  className="blind-lock-button"
                  onClick={() => setConfirming(true)}
                >
                  Lock round…
                </button>
              ) : (
                <div
                  className="blind-confirm"
                  role="alertdialog"
                  aria-labelledby="blind-confirm-text"
                >
                  <p id="blind-confirm-text">
                    Locking is final. You can't change ratings after this.
                  </p>
                  <div className="blind-confirm-actions">
                    <button
                      type="button"
                      ref={confirmRef}
                      className="blind-secondary"
                      onClick={() => setConfirming(false)}
                    >
                      Cancel
                    </button>
                    <button type="button" className="blind-lock-button" onClick={() => void lock()}>
                      Lock round
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      )}

      <nav className="blind-nav" aria-label="Answers">
        <button
          type="button"
          className="blind-secondary"
          disabled={step === 'grade' && index === 0}
          onClick={() => {
            if (step === 'lock' && bundle.rank) {
              setStep('rank');
              setConfirming(false);
            } else if (step !== 'grade') go(total - 1);
            else go(index - 1);
          }}
        >
          ← Prev
        </button>
        <button
          type="button"
          className="blind-primary"
          disabled={step === 'lock'}
          onClick={() => {
            if (step === 'rank') setStep('lock');
            else go(index + 1);
          }}
        >
          {step === 'grade' && index === total - 1
            ? bundle.rank
              ? 'Rank →'
              : 'Finish →'
            : 'Next →'}
        </button>
      </nav>

      <div className="blind-status" role="status" aria-live="polite">
        {status}
      </div>
      {error && (
        <div className="poll-preview-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

// ── Unblind ─────────────────────────────────────────────────────────

/**
 * The scores after unblinding. Babelr never sees the key: the button
 * leaves a request beside the round, and the tool that made the round
 * unblinds and writes the scores back.
 */
function UnblindPanel({
  bundle,
  requested,
  results,
  onRequest,
}: {
  bundle: BlindBundle;
  requested: boolean;
  results: BlindResults | null;
  onRequest: () => void;
}) {
  if (results && !results.error) {
    const arms = Object.entries(results.arms);
    const ranked = arms.some(([, a]) => a.mean_rank !== undefined);
    return (
      <div className="blind-results">
        <div className="blind-results-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Arm</th>
                {bundle.rubric.map((f) => (
                  <th key={f.id} scope="col">
                    {f.label}
                  </th>
                ))}
                {ranked && <th scope="col">Mean rank</th>}
              </tr>
            </thead>
            <tbody>
              {arms.map(([name, a]) => (
                <tr key={name}>
                  <th scope="row">{name}</th>
                  {bundle.rubric.map((f) => {
                    const v = a.fields[f.id];
                    if (!v) return <td key={f.id}>–</td>;
                    return (
                      <td key={f.id}>
                        {f.type === 'bool'
                          ? `${v.yes ?? 0} / ${v.rated}`
                          : `${v.mean ?? '–'} (n=${v.rated})`}
                      </td>
                    );
                  })}
                  {ranked && <td>{a.mean_rank ?? '–'}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="blind-results-note">
          Yes/no fields: yes out of rated. Scales: mean. Rank: 1 is best.
          {results.unblindedAt
            ? ` Unblinded ${new Date(results.unblindedAt).toLocaleString()}.`
            : ''}
        </p>
      </div>
    );
  }
  if (results?.error) {
    return (
      <p className="blind-warning">
        Unblinding didn't work: {results.error}. It tries again every minute.
      </p>
    );
  }
  if (requested) {
    return (
      <p className="blind-results-note" role="status">
        Unblinding… the scores show up here within a minute.
      </p>
    );
  }
  return (
    <>
      <p>
        See which answer came from where. Babelr never opens the key: this asks the tool that made
        the round to unblind it and send the scores back.
      </p>
      <button type="button" className="blind-lock-button" onClick={onRequest}>
        Unblind
      </button>
    </>
  );
}

export const BlindPreview = BlindGrader;

type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; rounds: BlindRoundSummary[] };

/** Rounds this account grades, newest name last (the server sorts). */
export async function fetchRounds(routeBase: string): Promise<BlindRoundSummary[]> {
  const res = await fetch(`${routeBase}/rounds`, { credentials: 'include', cache: 'no-store' });
  if (res.status === 403) return [];
  if (!res.ok) throw new Error(res.statusText);
  return (await res.json()) as BlindRoundSummary[];
}

function RoundList({ routeBase, onOpen }: { routeBase: string; onOpen: (round: string) => void }) {
  const [state, setState] = useState<ListState>({ kind: 'loading' });
  useEffect(() => {
    let live = true;
    fetchRounds(routeBase).then(
      (rounds) => live && setState({ kind: 'ok', rounds }),
      (err: Error) => live && setState({ kind: 'error', message: err.message }),
    );
    return () => {
      live = false;
    };
  }, [routeBase]);

  if (state.kind === 'loading') return <div className="poll-preview-loading">Loading rounds…</div>;
  if (state.kind === 'error') return <div className="poll-preview-error">{state.message}</div>;
  if (state.rounds.length === 0) {
    return (
      <p className="poll-view-empty">Nothing to grade. Rounds you're a grader on show up here.</p>
    );
  }
  const open = state.rounds.filter((r) => !r.lockedAt);
  const done = state.rounds.filter((r) => r.lockedAt);
  const item = (r: BlindRoundSummary) => (
    <li key={r.round}>
      <button
        type="button"
        className="poll-embed ok blind-embed"
        onClick={() => onOpen(r.round)}
        aria-label={`${r.title}: ${r.graded} of ${r.total} graded${r.lockedAt ? ', locked' : ''}`}
      >
        <span className="poll-embed-body">
          <span className="poll-embed-question">{r.title}</span>
          <span className="poll-embed-meta">
            {r.graded} of {r.total} graded{r.lockedAt ? ' · locked' : ''}
          </span>
          <span className="blind-progress" aria-hidden="true">
            <span
              className="blind-progress-bar"
              style={{ width: `${r.total ? (r.graded / r.total) * 100 : 0}%` }}
            />
          </span>
        </span>
      </button>
    </li>
  );
  return (
    <div className="blind-rounds">
      {open.length > 0 && (
        <>
          <h2 className="poll-preview-question">To grade</h2>
          <ul className="blind-round-list">{open.map(item)}</ul>
        </>
      )}
      {done.length > 0 && (
        <>
          <h2 className="poll-preview-question">Locked</h2>
          <ul className="blind-round-list">{done.map(item)}</ul>
        </>
      )}
    </div>
  );
}

export function BlindsView(props: Record<string, unknown>) {
  const { round, routeBase, onClose } = props as {
    round?: string;
    routeBase: string;
    onClose: () => void;
  };
  // Opened from an embed: that round. From the toolbar: the list, and
  // Back from a round you picked returns to it.
  const [picked, setPicked] = useState<string | null>(null);
  const showing = round ?? picked;
  return (
    <div className="blind-view">
      <div className="blind-view-bar">
        <button
          type="button"
          className="blind-secondary"
          onClick={() => (picked && !round ? setPicked(null) : onClose())}
        >
          ← Back
        </button>
      </div>
      {showing ? (
        <BlindGrader key={showing} slug={showing} routeBase={routeBase} />
      ) : (
        <RoundList routeBase={routeBase} onOpen={setPicked} />
      )}
    </div>
  );
}
