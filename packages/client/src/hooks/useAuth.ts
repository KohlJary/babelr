// SPDX-License-Identifier: Hippocratic-3.0
import { useState, useEffect, useCallback } from 'react';
import type { ActorProfile, RegisterInput, LoginInput } from '@babelr/shared';
import * as api from '../api';

export function useAuth() {
  const [actor, setActor] = useState<ActorProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Check existing session on mount
  useEffect(() => {
    api
      .getMe()
      .then(setActor)
      .catch(() => {
        // Not logged in
      })
      .finally(() => setLoading(false));
  }, []);

  const handleLogin = useCallback(async (input: LoginInput) => {
    setError(null);
    try {
      const profile = await api.login(input);
      setActor(profile);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login failed';
      setError(message);
      throw err;
    }
  }, []);

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
    login: handleLogin,
    register: handleRegister,
    logout: handleLogout,
    updateActor,
  };
}
