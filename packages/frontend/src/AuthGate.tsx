import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import App from './App';
import { LoginScreen } from './components/LoginScreen';
import type { AuthUser } from './types';

// Decide entre la pantalla de login y la app. La sesión vive en una cookie HttpOnly del backend
export function AuthGate() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth/me')
      .then(res => (res.ok ? res.json() : null))
      .then(data => setUser(data?.user ?? null))
      .catch(() => setUser(null))
      .finally(() => setChecking(false));
  }, []);

  const logout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      /* la cookie caduca sola; se vuelve al login igualmente */
    }
    setNotice(null);
    setUser(null);
  };

  // El backend respondió 401 a mitad de uso (cookie caducada o usuario retirado)
  const sessionExpired = () => {
    setNotice('Your session expired. Please sign in again.');
    setUser(null);
  };

  if (checking) {
    return (
      <div className="login-page">
        <Loader2 size={28} className="spin" color="var(--accent-primary)" />
      </div>
    );
  }

  if (!user) {
    return <LoginScreen notice={notice} onLogin={u => { setNotice(null); setUser(u); }} />;
  }

  // key: al cambiar de usuario la app se monta de cero (sin mensajes ni sesión del anterior)
  return <App key={user.id} user={user} onLogout={logout} onSessionExpired={sessionExpired} />;
}
