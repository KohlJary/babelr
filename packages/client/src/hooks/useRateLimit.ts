// SPDX-License-Identifier: MIT
import { useEffect, useState } from 'react';
import { getRateLimitState, onRateLimitChange, type RateLimitState } from '../api';

/** The app-wide rate-limit state from api.ts: when requests work again,
 *  and how many limited windows have passed (to reload after one). */
export function useRateLimit(): RateLimitState {
  const [state, setState] = useState<RateLimitState>(getRateLimitState);
  useEffect(() => onRateLimitChange(() => setState(getRateLimitState())), []);
  return state;
}
