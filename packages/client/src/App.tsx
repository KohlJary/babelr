// SPDX-License-Identifier: Hippocratic-3.0
import { useAuth } from './hooks/useAuth';
import { AuthForm } from './components/AuthForm';
import { ChatView } from './components/ChatView';
import { I18nProvider } from './i18n/I18nProvider';

export function App() {
  const { actor, loading, error, login, register, logout } = useAuth();

  if (loading) {
    return (
      <div className="app">
        <div className="loading">Loading...</div>
      </div>
    );
  }

  // Use the actor's preferred language if logged in, otherwise English.
  // The provider re-fetches the dict whenever lang changes.
  const lang = actor?.preferredLanguage ?? 'en';

  return (
    <I18nProvider lang={lang}>
      {!actor ? (
        <AuthForm onLogin={login} onRegister={register} error={error} />
      ) : (
        <ChatView actor={actor} onLogout={logout} />
      )}
    </I18nProvider>
  );
}
