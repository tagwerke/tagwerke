import { useState } from 'react';
import { useSession } from '../session/useSession';
import { ApiError } from '../api/client';

function messageFor(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.status) {
      case 401:
        return 'Invalid email or password.';
      case 403:
        return 'Invalid or exhausted invite code.';
      case 409:
        return 'That email is already registered.';
      case 429:
        return /lock/i.test(err.message)
          ? 'Account temporarily locked after too many attempts. Try again later.'
          : 'Too many attempts. Please wait a minute and try again.';
    }
  }
  return 'Something went wrong. Please try again.';
}

export function AuthScreen() {
  const login = useSession((s) => s.login);
  const signup = useSession((s) => s.signup);
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login') await login(email.trim(), password);
      else await signup(email.trim(), password, inviteCode.trim());
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <h1 className="auth-title">do</h1>
        <p className="auth-sub">{mode === 'login' ? 'Sign in to continue' : 'Create your account'}</p>

        <label className="auth-field">
          <span>email</span>
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
          />
        </label>

        <label className="auth-field">
          <span>password</span>
          <input
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {mode === 'signup' && (
          <label className="auth-field">
            <span>invite code</span>
            <input
              type="text"
              required
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              placeholder="required to sign up"
            />
          </label>
        )}

        {error && <div className="auth-error">{error}</div>}

        <button className="btn primary auth-submit" type="submit" disabled={busy}>
          {busy ? '…' : mode === 'login' ? 'Sign in' : 'Sign up'}
        </button>

        <button
          type="button"
          className="auth-toggle"
          onClick={() => {
            setMode((m) => (m === 'login' ? 'signup' : 'login'));
            setError(null);
          }}
        >
          {mode === 'login' ? 'Need an account? Sign up' : 'Have an account? Sign in'}
        </button>
      </form>
    </div>
  );
}
