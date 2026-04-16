// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect, useCallback } from 'react';
import type { ActorProfile, RegisterInput, LoginInput } from '@babelr/shared';
import * as api from '../api';

export function useAuth() {
  const [actor, setActor] = useState<ActorProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [twoFactorChallenge, setTwoFactorChallenge] = useState<string | null>(null);

  useEffect(() => {
    api
      .getMe()
      .then(setActor)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleLogin = useCallback(async (input: LoginInput) => {
    setError(null);
    try {
      const result = await api.login(input);
      if (result.type === '2fa') {
        setTwoFactorChallenge(result.challengeToken);
      } else {
        setActor(result.profile);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login failed';
      setError(message);
      throw err;
    }
  }, []);

  const handleComplete2fa = useCallback(async (code: string) => {
    if (!twoFactorChallenge) return;
    setError(null);
    try {
      const profile = await api.complete2faChallenge(twoFactorChallenge, code);
      setTwoFactorChallenge(null);
      setActor(profile);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid code';
      setError(message);
      throw err;
    }
  }, [twoFactorChallenge]);

  const handleRegister = useCallback(async (input: RegisterInput) => {
    setError(null);
    try {
      const profile = await api.register(input);
      setActor(profile);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Registration failed';
      setError(message);
      throw err;
    }
  }, []);

  const handleLogout = useCallback(async () => {
    await api.logout();
    setActor(null);
  }, []);

  const updateActor = useCallback((updated: ActorProfile) => {
    setActor(updated);
  }, []);

  return {
    actor,
    loading,
    error,
    twoFactorChallenge,
    login: handleLogin,
    complete2fa: handleComplete2fa,
    register: handleRegister,
    logout: handleLogout,
    updateActor,
  };
}
