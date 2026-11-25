// SPDX-License-Identifier: MIT
import { useAuth } from './hooks/useAuth';
import { AuthForm } from './components/AuthForm';
import { TwoFactorChallenge } from './components/TwoFactorChallenge';
import { ChatView } from './components/ChatView';
import { OnboardingWizard } from './components/OnboardingWizard';
import { I18nProvider } from './i18n/I18nProvider';
import { RateLimitBanner } from './components/RateLimitBanner';
import { useRateLimit } from './hooks/useRateLimit';
import { useEffect } from 'react';
import { setSignedIn } from './session';

export function App() {
  const rateLimit = useRateLimit();
  const {
    actor,
    loading,
    error,
    twoFactorChallenge,
    login,
    complete2fa,
    register,
    logout,
    updateActor,
  } = useAuth(rateLimit.recoveries);

  // Tell code outside React (plugins) once the session is known.
  useEffect(() => {
    setSignedIn(!!actor);
  }, [actor]);

  if (loading) {
    return (
      <div className="app">
        <RateLimitBanner until={rateLimit.until} />
        <div className="loading">Loading...</div>
      </div>
    );
  }

  const lang = actor?.preferredLanguage ?? 'en';
  const needsOnboarding = actor && !actor.displayName;

  return (
    <I18nProvider lang={lang}>
      <RateLimitBanner until={rateLimit.until} />
      {twoFactorChallenge ? (
        <TwoFactorChallenge onSubmit={complete2fa} error={error} />
      ) : !actor ? (
        <AuthForm onLogin={login} onRegister={register} error={error} />
      ) : needsOnboarding ? (
        <OnboardingWizard actor={actor} onComplete={updateActor} />
      ) : (
        // Remounted when a rate-limited window passes, so everything that
        // failed to load while limited (servers, DMs, the socket) loads again.
        <ChatView
          key={rateLimit.recoveries}
          actor={actor}
          onLogout={logout}
          onActorUpdate={updateActor}
        />
      )}
    </I18nProvider>
  );
}
