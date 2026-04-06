// SPDX-License-Identifier: Hippocratic-3.0
import { useAuth } from './hooks/useAuth';
import { AuthForm } from './components/AuthForm';
import { ChatView } from './components/ChatView';

export function App() {
  const { actor, loading, error, login, register, logout } = useAuth();

  if (loading) {
    return (
      <div className="app">
        <div className="loading">Loading...</div>
      </div>
    );
  }

  if (!actor) {
    return <AuthForm onLogin={login} onRegister={register} error={error} />;
  }

  return <ChatView actor={actor} onLogout={logout} />;
}
