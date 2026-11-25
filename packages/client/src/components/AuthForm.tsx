// SPDX-License-Identifier: MIT
import { useState, useEffect } from 'react';
import type { RegisterInput, LoginInput, RegistrationInfo, InvitePreview } from '@babelr/shared';
import { useT } from '../i18n/I18nProvider';

interface AuthFormProps {
  onLogin: (input: LoginInput) => Promise<void>;
  onRegister: (input: RegisterInput) => Promise<void>;
  error: string | null;
}

/** The code in an invite link (/invite/:code), if this page is one. */
function inviteCodeFromPath(): string | null {
  const match = window.location.pathname.match(/^\/invite\/([A-Za-z0-9_-]{1,32})\/?$/);
  return match ? match[1] : null;
}

export function AuthForm({ onLogin, onRegister, error }: AuthFormProps) {
  const t = useT();
  const [inviteCode] = useState(inviteCodeFromPath);
  // An invite link is almost always a new person: start on sign-up.
  const [mode, setMode] = useState<'login' | 'register'>(inviteCode ? 'register' : 'login');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [ssoEnabled, setSsoEnabled] = useState(false);
  const [registration, setRegistration] = useState<RegistrationInfo | null>(null);
  const [invite, setInvite] = useState<InvitePreview | null>(null);

  useEffect(() => {
    fetch('/api/auth/sso-config')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.oidcEnabled) setSsoEnabled(true);
      })
      .catch(() => {});
    fetch('/api/auth/registration')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: RegistrationInfo | null) => {
        if (data) setRegistration(data);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!inviteCode) return;
    fetch(`/api/invites/${encodeURIComponent(inviteCode)}`)
      .then((r) => r.json())
      .then((data: InvitePreview) => setInvite(data))
      .catch(() => setInvite({ valid: false }));
  }, [inviteCode]);

  const inviteValid = !!invite?.valid;
  // Sign-up is possible unless it's closed, or needs an invite and
  // this page doesn't carry a working one.
  const signupBlocked = !!registration?.closed || (!!registration?.inviteRequired && !inviteValid);
  const showSignupFields = mode === 'register' && !signupBlocked;
  const showFields = mode === 'login' || showSignupFields;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      if (mode === 'login') {
        await onLogin({ email, password });
      } else {
        await onRegister({
          username,
          email,
          password,
          ...(inviteCode && inviteValid ? { inviteCode } : {}),
        });
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
        {inviteCode && invite && (
          <div className={invite.valid ? 'auth-notice' : 'auth-error'} role="status">
            {invite.valid && invite.server ? (
              <>
                <strong>
                  {invite.invitedBy
                    ? t('auth.invitedBy', { who: invite.invitedBy.name, name: invite.server.name })
                    : t('auth.invitedTo', { name: invite.server.name })}
                </strong>
                <div>{t('auth.invitedHint')}</div>
              </>
            ) : (
              <>
                <strong>{t('auth.inviteInvalid')}</strong>
                <div>{t('auth.inviteInvalidHint')}</div>
              </>
            )}
          </div>
        )}

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

        {mode === 'register' && signupBlocked && (
          <div className="auth-notice" role="status">
            {registration?.closed ? (
              <strong>{t('auth.registrationClosed')}</strong>
            ) : (
              <>
                <strong>{t('auth.inviteRequired')}</strong>
                <div>{t('auth.inviteRequiredHint')}</div>
              </>
            )}
          </div>
        )}

        {showSignupFields && (
          <input
            type="text"
            placeholder={t('auth.username')}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            minLength={3}
            maxLength={32}
            pattern="[a-zA-Z0-9_]+"
            autoComplete="username"
          />
        )}
        {showFields && (
          <>
            <input
              type="email"
              placeholder={t('auth.email')}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
            <input
              type="password"
              placeholder={t('auth.password')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={12}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </>
        )}

        {error && <div className="auth-error">{error}</div>}

        {showFields && (
          <button type="submit" className="auth-submit" disabled={submitting}>
            {submitting ? '...' : mode === 'login' ? t('auth.login') : t('auth.createAccount')}
          </button>
        )}

        {ssoEnabled && (
          <>
            <div className="auth-divider">
              <span>{t('auth.or')}</span>
            </div>
            <a href="/api/auth/oidc/authorize" className="auth-submit auth-sso-btn">
              {t('auth.ssoLogin')}
            </a>
          </>
        )}
      </form>
    </div>
  );
}
