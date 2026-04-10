// SPDX-License-Identifier: Hippocratic-3.0
import { useState } from 'react';
import type { RegisterInput, LoginInput } from '@babelr/shared';
import { useT } from '../i18n/I18nProvider';

interface AuthFormProps {
  onLogin: (input: LoginInput) => Promise<void>;
  onRegister: (input: RegisterInput) => Promise<void>;
  error: string | null;
}

export function AuthForm({ onLogin, onRegister, error }: AuthFormProps) {
  const t = useT();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      if (mode === 'login') {
        await onLogin({ email, password });
      } else {
        await onRegister({ username, email, password });
      }
    } catch {
      // Error handled by parent
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-container">
      <h1>{t('app.name')}</h1>
      <p className="auth-subtitle">{t('app.tagline')}</p>

      <form className="auth-form" onSubmit={handleSubmit}>
        <div className="auth-tabs">
          <button
            type="button"
            className={`auth-tab ${mode === 'login' ? 'active' : ''}`}
            onClick={() => setMode('login')}
          >
            {t('auth.login')}
          </button>
          <button
            type="button"
            className={`auth-tab ${mode === 'register' ? 'active' : ''}`}
            onClick={() => setMode('register')}
          >
            {t('auth.register')}
          </button>
        </div>

        {mode === 'register' && (
          <input
            type="text"
            placeholder={t('auth.username')}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            minLength={3}
            maxLength={32}
            pattern="[a-zA-Z0-9_]+"
          />
        )}
        <input
          type="email"
          placeholder={t('auth.email')}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder={t('auth.password')}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={12}
        />

        {error && <div className="auth-error">{error}</div>}

        <button type="submit" className="auth-submit" disabled={submitting}>
          {submitting ? '...' : mode === 'login' ? t('auth.login') : t('auth.createAccount')}
        </button>
      </form>
    </div>
  );
}
