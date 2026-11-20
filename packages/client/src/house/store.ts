// SPDX-License-Identifier: MIT
import { useSyncExternalStore } from 'react';
import type { HouseIntro, HouseView } from '@babelr/shared';
import * as api from '../api';

/**
 * The House's front door: who lives here (GET /house), and the intro
 * (prologue, then tour) the house's members wrote. One small store, so the
 * rail, the home view and the tour overlay all read the same members and
 * the tour survives moving between views.
 */

export type TourPhase = 'idle' | 'prologue' | 'tour' | 'paused' | 'end';

interface State {
  house: HouseView | null;
  intro: HouseIntro | null;
  phase: TourPhase;
  step: number;
}

let state: State = { house: null, intro: null, phase: 'idle', step: 0 };
const listeners = new Set<() => void>();
const SEEN_KEY = 'babelr.house.introSeen';

function set(next: Partial<State>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

/** The house as last loaded (null before the first load). */
export function currentHouse(): HouseView | null {
  return state.house;
}

export function useHouseStore(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

let loading: Promise<void> | null = null;
export function loadHouse(force = false): Promise<void> {
  if (loading && !force) return loading;
  loading = api
    .getHouse()
    .then((house) => set({ house }))
    .catch(() => set({ house: { agents: [], people: [], hasIntro: false } }));
  return loading;
}

function seen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return true; // no storage: don't replay the intro on every visit
  }
}
function markSeen() {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* per-viewer convenience only */
  }
}

/** Lines nobody has written yet are skipped, never filled in for them. */
const written = <T extends { text: string | null }>(xs: T[]) => xs.filter((x) => !!x.text);

export async function startIntro(): Promise<void> {
  const intro = state.intro ?? (await api.getHouseIntro().catch(() => null));
  if (!intro) return;
  const cleaned = { ...intro, prologue: written(intro.prologue), tour: written(intro.tour) };
  set({ intro: cleaned, phase: cleaned.prologue.length ? 'prologue' : 'tour', step: 0 });
}

/** On first visit to a house with an intro, play it once. */
export async function maybeAutoplay(): Promise<void> {
  await loadHouse();
  if (state.house?.hasIntro && !seen() && state.phase === 'idle') {
    markSeen();
    await startIntro();
  }
}

export function toTour() {
  set({ phase: state.intro?.tour.length ? 'tour' : 'end', step: 0 });
}
export function nextStep() {
  const n = state.intro?.tour.length ?? 0;
  if (state.step + 1 >= n) set({ phase: 'end' });
  else set({ step: state.step + 1 });
}
export function pauseTour() {
  set({ phase: 'paused' });
}
export function resumeTour() {
  set({ phase: 'tour' });
}
export function leaveTour() {
  markSeen();
  set({ phase: 'idle', step: 0 });
}
