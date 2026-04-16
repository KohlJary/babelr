// SPDX-License-Identifier: Hippocratic-3.0
import { useAuth } from './hooks/useAuth';
import { AuthForm } from './components/AuthForm';
import { TwoFactorChallenge } from './components/TwoFactorChallenge';
import { ChatView } from './components/ChatView';
import { OnboardingWizard } from './components/OnboardingWizard';
import { I18nProvider } from './i18n/I18nProvider';

export function App() {
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
  } = useAuth();

  if (loading) {
    return (
      <div className="app">
        <div className="loading">Loading...</div>
      </div>
    );
  }

  const lang = actor?.preferredLanguage ?? 'en';
  const needsOnboarding = actor && !actor.displayName;

  return (
    <I18nProvider lang={lang}>
      {twoFactorChallenge ? (
        <TwoFactorChallenge onSubmit={complete2fa} error={error} />
      ) : !actor ? (
        <AuthForm onLogin={login} onRegister={register} error={error} />
      ) : needsOnboarding ? (
        <OnboardingWizard actor={actor} onComplete={updateActor} />
      ) : (
        <ChatView actor={actor} onLogout={logout} onActorUpdate={updateActor} />
      )}
    </I18nProvider>
  );
}
