import { useState } from 'react';
import { useSession } from '../session/useSession';
import { ApiError, auth as authApi } from '../api/client';

type Mode = 'login' | 'signup' | 'forgot' | 'reset';

// A reset link (…/reset?token=…) lands here unauthenticated; start in reset mode.
function initialResetToken(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('token');
}

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
  const resetToken = initialResetToken();
  const [mode, setMode] = useState<Mode>(resetToken ? 'reset' : 'login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [totpRequired, setTotpRequired] = useState(false);
  const [totp, setTotp] = useState('');

  const goto = (m: Mode) => {
    setMode(m);
    setError(null);
    setNotice(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === 'login') {
        const res = await login(email.trim(), password, totpRequired ? totp.trim() : undefined);
        if (res.totpRequired) {
          // Password accepted; ask for the 2FA code and re-submit.
          setTotpRequired(true);
          if (totpRequired) setError('Invalid code. Try again.');
        }
      } else if (mode === 'signup') {
        await signup(email.trim(), password, inviteCode.trim());
      } else if (mode === 'forgot') {
        await authApi.forgot(email.trim());
        // Neutral message — never reveal whether the address exists.
        setNotice('If that email is registered, a reset link is on its way.');
      } else if (mode === 'reset') {
        if (!resetToken) throw new Error('missing token');
        await authApi.reset(resetToken, password);
        setNotice('Password updated. You can sign in now.');
        setMode('login');
        // Drop the token from the URL so a refresh doesn't reopen reset mode.
        window.history.replaceState(null, '', window.location.pathname);
      }
    } catch (err) {
      // While on the 2FA step, a 401/429 means a bad/locked code, not bad credentials.
      if (mode === 'login' && totpRequired && err instanceof ApiError && (err.status === 401 || err.status === 429)) {
        setError(err.status === 429 ? 'Too many attempts — account locked. Try again later.' : 'Invalid code. Try again.');
      } else {
        setError(messageFor(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const title =
    mode === 'login' ? 'Sign in to continue'
    : mode === 'signup' ? 'Create your account'
    : mode === 'forgot' ? 'Reset your password'
    : 'Choose a new password';
  const showEmail = mode === 'login' || mode === 'signup' || mode === 'forgot';
  const showPasswordField = mode === 'login' || mode === 'signup' || mode === 'reset';
  const submitLabel =
    mode === 'login' ? 'Sign in'
    : mode === 'signup' ? 'Sign up'
    : mode === 'forgot' ? 'Send reset link'
    : 'Update password';

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <h1 className="auth-title">do</h1>
        <p className="auth-sub">{title}</p>

        {showEmail && (
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
        )}

        {showPasswordField && (
          <label className="auth-field">
            <span>{mode === 'reset' ? 'new password' : 'password'}</span>
            <div className="auth-password">
            <input
              type={showPassword ? 'text' : 'password'}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus={mode === 'reset'}
            />
            <button
              type="button"
              className="auth-reveal"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
              title={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? (
                <svg viewBox="0 0 16 16" width="16" height="16"><path d="M2 2l12 12M6.5 6.6a2 2 0 002.8 2.8M4.3 4.5C2.8 5.5 1.5 8 1.5 8s2.5 4.5 6.5 4.5c1.2 0 2.2-.3 3.1-.8M9.5 3.6C9 3.5 8.5 3.5 8 3.5 4 3.5 1.5 8 1.5 8m13 0s-1-1.9-2.8-3.2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
              ) : (
                <svg viewBox="0 0 16 16" width="16" height="16"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="currentColor" strokeWidth="1.2"/><circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" strokeWidth="1.2"/></svg>
              )}
            </button>
            </div>
          </label>
        )}

        {mode === 'login' && totpRequired && (
          <label className="auth-field">
            <span>two-factor code</span>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              value={totp}
              onChange={(e) => setTotp(e.target.value)}
              placeholder="6-digit code or backup code"
              autoFocus
            />
          </label>
        )}

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

        {notice && <div className="auth-notice">{notice}</div>}
        {error && <div className="auth-error">{error}</div>}

        <button className="btn primary auth-submit" type="submit" disabled={busy}>
          {busy ? '…' : submitLabel}
        </button>

        {mode === 'login' && (
          <button type="button" className="auth-toggle" onClick={() => goto('forgot')}>
            Forgot your password?
          </button>
        )}

        <button
          type="button"
          className="auth-toggle"
          onClick={() => {
            if (mode === 'login') goto('signup');
            else if (mode === 'signup') goto('login');
            else goto('login'); // forgot / reset → back to sign in
          }}
        >
          {mode === 'login'
            ? 'Need an account? Sign up'
            : mode === 'signup'
              ? 'Have an account? Sign in'
              : 'Back to sign in'}
        </button>
      </form>
    </div>
  );
}
