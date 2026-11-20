// SPDX-License-Identifier: MIT
import { useEffect, useMemo, useRef, useState } from 'react';
import type { HouseMember, IntroLine } from '@babelr/shared';
import { useT } from '../i18n/I18nProvider';
import { leaveTour, nextStep, pauseTour, resumeTour, toTour, useHouseStore } from './store';
import './house.css';

/**
 * The intro, over the whole app. Act 1, the prologue: the members talk
 * in a dark room, one line at a time, typed out at reading speed. Act 2,
 * the tour: a guide docked at the bottom of the real app, each step in
 * one member's voice, pointing at the part they're explaining; "Ask"
 * opens a real DM with them. Act 3, the end: the invitation.
 *
 * Every line was written by the member it's attributed to (the intro
 * file says so); lines nobody has written yet are skipped, never filled.
 */

const CHARS_PER_SECOND = 42;

function reducedMotion() {
  return (
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}

function useMembers() {
  const { house } = useHouseStore();
  return useMemo(() => {
    const map = new Map<string, HouseMember>();
    for (const m of [...(house?.agents ?? []), ...(house?.people ?? [])])
      map.set(m.preferredUsername, m);
    return map;
  }, [house]);
}

function Speaker({ m, by }: { m?: HouseMember; by: string }) {
  return (
    <span className="intro-speaker">
      {m?.avatarUrl ? (
        <img src={m.avatarUrl} alt="" className="intro-face" />
      ) : (
        <span className="intro-face intro-face-blank" />
      )}
      <span className="intro-name">{m?.displayName ?? by}</span>
      {m?.sigil && <span className="intro-sigil">{m.sigil}</span>}
    </span>
  );
}

function Typed({ text, onDone }: { text: string; onDone: () => void }) {
  const [n, setN] = useState(reducedMotion() ? text.length : 0);
  const done = useRef(false);
  useEffect(() => {
    if (n >= text.length) {
      if (!done.current) {
        done.current = true;
        onDone();
      }
      return;
    }
    const id = setTimeout(() => setN((x) => Math.min(text.length, x + 1)), 1000 / CHARS_PER_SECOND);
    return () => clearTimeout(id);
  }, [n, text, onDone]);
  return (
    <span aria-label={text}>
      <span aria-hidden="true">{text.slice(0, n)}</span>
      {n < text.length && <span className="intro-caret" aria-hidden="true" />}
    </span>
  );
}

function Prologue() {
  const t = useT();
  const { intro } = useHouseStore();
  const members = useMembers();
  const lines: IntroLine[] = intro?.prologue ?? [];
  const [shown, setShown] = useState(1);
  const [typing, setTyping] = useState(true);
  const bottom = useRef<HTMLDivElement>(null);
  const finished = shown >= lines.length && !typing;

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'end' });
  }, [shown, typing]);

  useEffect(() => {
    if (typing || shown >= lines.length) return;
    const id = setTimeout(() => {
      setShown((s) => s + 1);
      setTyping(true);
    }, lines[shown]?.pause ?? 900);
    return () => clearTimeout(id);
  }, [typing, shown, lines]);

  const speaker = members.get(lines[shown - 1]?.by ?? '');
  return (
    <div
      className="intro-stage"
      role="dialog"
      aria-modal="true"
      aria-label={intro?.house ?? t('house.title')}
    >
      {speaker?.avatarUrl && (
        <div
          key={speaker.id}
          className="intro-wash"
          aria-hidden="true"
          style={{ ['--face' as string]: `url("${speaker.avatarUrl}")` }}
        />
      )}
      <div className="intro-room">
        <p className="intro-channel"># {intro?.house ?? t('house.title')}</p>
        <ol className="intro-lines">
          {lines.slice(0, shown).map((line, i) => (
            <li key={i} className={`intro-line${i < shown - 2 ? ' intro-line-past' : ''}`}>
              <Speaker m={members.get(line.by)} by={line.by} />
              <p className="intro-text">
                {i === shown - 1 && typing ? (
                  <Typed text={line.text ?? ''} onDone={() => setTyping(false)} />
                ) : (
                  line.text
                )}
              </p>
            </li>
          ))}
        </ol>
        <div ref={bottom} />
      </div>
      <footer className="intro-foot">
        <span className="intro-credit">{intro?.credit}</span>
        <span className="intro-foot-actions">
          {!finished && (
            <button type="button" className="house-btn" onClick={toTour}>
              {t('house.skip')}
            </button>
          )}
          {finished && (
            <button
              type="button"
              className="house-btn house-btn-solid intro-enter"
              onClick={toTour}
              autoFocus
            >
              {t('house.enter')}
            </button>
          )}
        </span>
      </footer>
    </div>
  );
}

interface TourProps {
  openView: (id: string, state?: Record<string, unknown>) => void;
  startDM: (actorId: string) => void;
}

function TourGuide({ openView, startDM }: TourProps) {
  const t = useT();
  const { intro, step } = useHouseStore();
  const members = useMembers();
  const s = intro?.tour[step];
  const open = useRef(openView);
  open.current = openView;

  useEffect(() => {
    if (!s?.target) return;
    const target = s.target;
    if (target.startsWith('member:')) open.current('house', { member: target.slice(7) });
    else if (['home', 'start-your-own', 'rail'].includes(target)) open.current('house');
    else if (target !== 'sidebar') open.current(target, s.state ?? {});
    const lit = () => {
      document.querySelectorAll('.tour-lit').forEach((el) => el.classList.remove('tour-lit'));
      document.querySelectorAll(`[data-tour="${CSS.escape(target)}"]`).forEach((el) => {
        el.classList.add('tour-lit');
        el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
      });
    };
    const id = setTimeout(lit, 120); // after the view renders
    return () => {
      clearTimeout(id);
      document.querySelectorAll('.tour-lit').forEach((el) => el.classList.remove('tour-lit'));
    };
  }, [s?.target, step]);

  if (!intro || !s) return null;
  const m = members.get(s.by);
  const last = step + 1 >= intro.tour.length;
  return (
    <div className="tour-guide" role="region" aria-label={t('house.tour')} aria-live="polite">
      <Speaker m={m} by={s.by} />
      <p className="tour-text">{s.text}</p>
      <div className="tour-actions">
        {m && m.canTalk && (
          <button
            type="button"
            className="house-btn"
            onClick={() => {
              pauseTour();
              startDM(m.id);
            }}
          >
            {t('house.ask', { name: m.displayName ?? m.preferredUsername })}
          </button>
        )}
        <button type="button" className="house-btn house-btn-solid" onClick={nextStep}>
          {last ? t('house.finish') : t('house.next')}
        </button>
        <button type="button" className="house-link" onClick={leaveTour}>
          {t('house.leaveTour')}
        </button>
      </div>
    </div>
  );
}

function TheEnd() {
  const t = useT();
  const { intro } = useHouseStore();
  const members = useMembers();
  const end = intro?.end;
  return (
    <div
      className="intro-stage intro-end"
      role="dialog"
      aria-modal="true"
      aria-label={t('house.ownTitle')}
    >
      <div className="intro-end-card">
        {end?.text && (
          <>
            <Speaker m={members.get(end.by)} by={end.by} />
            <p className="intro-end-text">{end.text}</p>
          </>
        )}
        <div className="intro-end-actions">
          <a
            className="house-btn house-btn-solid"
            href={end?.href}
            target="_blank"
            rel="noreferrer"
          >
            {end?.cta ?? t('house.ownCta')}
          </a>
          <button type="button" className="house-btn" onClick={leaveTour} autoFocus>
            {t('house.lookAround')}
          </button>
        </div>
      </div>
    </div>
  );
}

export function IntroOverlay(props: TourProps) {
  const t = useT();
  const { phase } = useHouseStore();
  if (phase === 'prologue') return <Prologue />;
  if (phase === 'tour') return <TourGuide {...props} />;
  if (phase === 'end') return <TheEnd />;
  if (phase === 'paused')
    return (
      <button type="button" className="tour-resume house-btn house-btn-solid" onClick={resumeTour}>
        {t('house.resumeTour')}
      </button>
    );
  return null;
}
