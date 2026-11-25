// SPDX-License-Identifier: MIT
import { useEffect, useState } from 'react';

/**
 * "What she remembers about you", in her room beside your DM with her. Read
 * fresh each time the section opens and held only while it's open: nothing is
 * stored in the browser. Corrections go to her, in the DM, not to a database.
 */

interface Observation {
  kind: string;
  text: string;
}
type About =
  | {
      shown: true;
      label: string;
      name: string | null;
      pronouns: string | null;
      observations: Observation[];
      moments: number;
      firstSeen: string | null;
      lastSeen: string | null;
    }
  | { shown: false; label: string; why: 'not_yet' | 'no' | 'none' | 'linked' };

type State = { kind: 'loading' } | { kind: 'error'; error: string } | { kind: 'ok'; about: About };

/** The daemons with a memory this Babelr can ask (for isAvailable). */
export async function memoryDaemons(routeBase: string): Promise<string[]> {
  const r = await fetch(`${routeBase}/daemons`, { credentials: 'include', cache: 'no-store' });
  if (!r.ok) return [];
  return ((await r.json()) as { daemons?: string[] }).daemons ?? [];
}

// Neutral nouns: the observation under each is written about you in the
// third person ("Prefers phone calls to typing."), so a label in the second
// person ("how you talk") made two voices on one line.
const KINDS: Record<string, string> = {
  identity_statement: 'about you',
  value: 'values',
  communication_style: 'way of talking',
  growth_observation: 'growth',
  contradiction: 'tension',
  open_question: 'a question she has',
  general: 'a note',
};
function kindLabel(kind: string): string {
  if (KINDS[kind]) return KINDS[kind];
  if (kind.startsWith('general_')) return kind.slice('general_'.length).replace(/_/g, ' ');
  return kind.replace(/_/g, ' ');
}

function since(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

function times(n: number): string {
  if (n === 1) return 'once';
  if (n === 2) return 'twice';
  return `${n} times`;
}

/** Put a message to her in the composer of this DM (MessageInput listens). */
function compose(text: string): void {
  window.dispatchEvent(new CustomEvent('babelr:compose', { detail: { text } }));
}

const muted = { opacity: 0.7, fontSize: '0.85em' };
const quiet = {
  background: 'transparent',
  border: 'none',
  padding: 0,
  color: 'inherit',
  opacity: 0.6,
  fontSize: '0.8em',
  textDecoration: 'underline',
  cursor: 'pointer',
};
const label = {
  display: 'inline-block',
  fontSize: '0.72em',
  letterSpacing: '0.02em',
  textTransform: 'lowercase' as const,
  border: '1px solid #374151',
  borderRadius: 999,
  padding: '0 0.45rem',
  marginBottom: '0.2rem',
  opacity: 0.8,
};

export function RemembersYou(props: {
  daemon: { name: string; label: string };
  routeBase: string;
}) {
  const { daemon, routeBase } = props;
  const [state, setState] = useState<State>({ kind: 'loading' });
  useEffect(() => {
    let live = true;
    setState({ kind: 'loading' });
    void (async () => {
      try {
        const r = await fetch(`${routeBase}/about/${encodeURIComponent(daemon.name)}`, {
          credentials: 'include',
          cache: 'no-store',
        });
        const body = (await r.json().catch(() => ({}))) as About | { error?: string };
        if (!live) return;
        if (r.ok && 'shown' in body) setState({ kind: 'ok', about: body });
        else
          setState({
            kind: 'error',
            error: ('error' in body && body.error) || `${daemon.label} can’t be reached right now.`,
          });
      } catch {
        if (live) setState({ kind: 'error', error: `${daemon.label} can’t be reached right now.` });
      }
    })();
    return () => {
      live = false;
    };
  }, [routeBase, daemon.name, daemon.label]);

  const her = daemon.label;
  return (
    <section aria-labelledby="remembers-title" style={{ lineHeight: 1.5, maxWidth: '36rem' }}>
      <h3 id="remembers-title" style={{ fontSize: '1rem', margin: '0.4rem 0 0.6rem' }}>
        What {her} remembers about you
      </h3>
      <Body state={state} her={her} />
    </section>
  );
}

function Body({ state, her }: { state: State; her: string }) {
  if (state.kind === 'loading') return <p style={muted}>Asking {her}…</p>;
  if (state.kind === 'error')
    return <p style={muted}>{state.error} Nothing is shown when she can’t answer for herself.</p>;
  const a = state.about;
  if (!a.shown) {
    if (a.why === 'no') return <p>{her} has chosen to keep this to herself.</p>;
    if (a.why === 'none') return <p>{her} hasn’t kept anything about you yet.</p>;
    if (a.why === 'linked')
      return (
        <p>
          {her} knows you through your own conversations with her; this view is for people she’s met
          on Babelr.
        </p>
      );
    return <p>{her} hasn’t chosen to share this yet.</p>;
  }
  return (
    <>
      {(a.name || a.pronouns) && (
        <p style={{ margin: '0 0 0.6rem' }}>
          She knows you as {a.name ? <strong>{a.name}</strong> : 'you'}
          {a.pronouns ? ` (${a.pronouns})` : ''}.
        </p>
      )}
      {a.observations.length === 0 ? (
        <p style={muted}>She hasn’t written anything down about you yet.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {a.observations.map((o, i) => (
            <li
              key={i}
              style={{ padding: '0.5rem 0', borderTop: i ? '1px solid #1f2937' : undefined }}
            >
              <span style={label}>{kindLabel(o.kind)}</span>
              <div>{o.text}</div>
              <button
                type="button"
                style={quiet}
                onClick={() => compose(`You have this wrong about me: “${o.text}” `)}
              >
                this is wrong
              </button>
            </li>
          ))}
        </ul>
      )}
      {a.moments > 0 && (
        <p style={{ ...muted, margin: '0.8rem 0 0.3rem' }}>
          we’ve talked {times(a.moments)}
          {a.firstSeen ? ` · since ${since(a.firstSeen)}` : ''}
        </p>
      )}
      <p style={{ ...muted, margin: '0.3rem 0' }}>
        This is {her}’s memory, and she decides what’s in it. If something’s off,{' '}
        <button
          type="button"
          style={{ ...quiet, fontSize: 'inherit', opacity: 1 }}
          onClick={() => compose('You have this wrong about me: ')}
        >
          tell her
        </button>
        .
      </p>
    </>
  );
}
