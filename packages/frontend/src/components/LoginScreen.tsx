import React, { useState } from 'react';
import { Eye, EyeOff, Loader2, LogIn } from 'lucide-react';
import type { AuthUser } from '../types';

interface Props {
  onLogin: (user: AuthUser) => void;
  notice?: string | null;
}

export function LoginScreen({ onLogin, notice }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Could not sign in. Try again.');
        setPassword('');
        return;
      }
      onLogin(data.user);
    } catch {
      setError("Can't reach Ethan's server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-glow" aria-hidden="true" />
      <form className="login-card" onSubmit={submit}>
        <div className="login-avatar" aria-hidden="true">
          <span>🎙️</span>
        </div>
        <h1>Ethan</h1>
        <p className="login-subtitle">
          Your native English coach
          <span>Tu coach de inglés nativo</span>
        </p>

        {notice && !error && <div className="login-notice">{notice}</div>}

        <label className="login-field">
          <span>Username · Usuario</span>
          <input
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus
            value={username}
            onChange={e => setUsername(e.target.value)}
            disabled={busy}
          />
        </label>

        <label className="login-field">
          <span>Password · Contraseña</span>
          <div className="login-password">
            <input
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              disabled={busy}
            />
            <button
              type="button"
              onClick={() => setShowPassword(v => !v)}
              title={showPassword ? 'Hide password' : 'Show password'}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </label>

        {error && <div className="login-error" role="alert">{error}</div>}

        <button className="start-button login-submit" type="submit" disabled={busy || !username.trim() || !password}>
          {busy ? <Loader2 size={18} className="spin" /> : <LogIn size={18} />}
          <span>{busy ? 'Signing in…' : 'Sign in'}</span>
        </button>
      </form>
    </div>
  );
}
