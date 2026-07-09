import { useEffect, useState } from 'react';
import { browserSupportsWebAuthn, browserSupportsWebAuthnAutofill } from '@simplewebauthn/browser';
import { useSession } from '../session/useSession';
import { ApiError, auth as authApi, type OidcPublic } from '../api/client';

// A user cancelling/dismissing a passkey prompt throws NotAllowedError — treat as a no-op.
function isPasskeyCancel(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError');
}

type Mode = 'login' | 'signup' | 'forgot' | 'reset';

// A reset link (…/reset?token=…) lands here unauthenticated; start in reset mode.
function initialResetToken(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('token');
}

// The OIDC callback redirects back with ?sso_error=<code> on failure.
function ssoErrorMessage(code: string): string {
  switch (code) {
    case 'domain': return 'Your email domain isn’t allowed to sign in here.';
    case 'invite_required': return 'No account yet — enter an invite code to join with SSO.';
    case 'invite_invalid': return 'That invite code is invalid or has been used up.';
    case 'deactivated': return 'This account has been deactivated.';
    case 'disabled': return 'SSO is not enabled.';
    case 'no_email': return 'Your identity provider didn’t share a verified email.';
    default: return 'SSO sign-in failed. Please try again.';
  }
}
function initialSsoError(): string | null {
  if (typeof window === 'undefined') return null;
  const code = new URLSearchParams(window.location.search).get('sso_error');
  return code ? ssoErrorMessage(code) : null;
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
  const passkeyLogin = useSession((s) => s.passkeyLogin);
  const passkeyConditional = useSession((s) => s.passkeyConditional);
  const resetToken = initialResetToken();
  const [mode, setMode] = useState<Mode>(resetToken ? 'reset' : 'login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialSsoError());
  const [notice, setNotice] = useState<string | null>(null);
  const [totpRequired, setTotpRequired] = useState(false);
  const [totp, setTotp] = useState('');
  const [sso, setSso] = useState<OidcPublic | null>(null);
  const [pkBusy, setPkBusy] = useState(false);
  const pkSupported = browserSupportsWebAuthn();

  useEffect(() => {
    // Discover whether SSO is offered (drives the button + password-form hiding).
    authApi.oidcPublic().then(setSso).catch(() => {});
    // Strip a one-shot ?sso_error from the URL (the message is already in state).
    if (new URLSearchParams(window.location.search).get('sso_error')) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  // Conditional-UI (autofill): if supported, quietly start a passkey ceremony so returning
  // users get a passkey suggestion in the email field. Resolves on pick; ignore cancels.
  useEffect(() => {
    let cancelled = false;
    browserSupportsWebAuthnAutofill()
      .then((ok) => {
        if (ok && !cancelled) passkeyConditional().catch(() => {});
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [passkeyConditional]);

  // Kick off SSO. Any invite code the user typed rides along in the query string; the server
  // only consumes it if this sign-in provisions a NEW account (existing users ignore it).
  const startSso = () => {
    const code = inviteCode.trim();
    window.location.href = `/api/auth/oidc/start${code ? `?invite=${encodeURIComponent(code)}` : ''}`;
  };

  const doPasskey = async () => {
    setPkBusy(true);
    setError(null);
    try {
      await passkeyLogin();
    } catch (err) {
      if (!isPasskeyCancel(err)) setError('Passkey sign-in failed. Try again.');
    } finally {
      setPkBusy(false);
    }
  };

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
  // When the org has disabled password login, the login screen shows only passkey + SSO.
  const pwDisabledLogin = mode === 'login' && !!sso?.passwordDisabled;
  const showEmail = (mode === 'login' || mode === 'signup' || mode === 'forgot') && !pwDisabledLogin;
  const showPasswordField = (mode === 'login' || mode === 'signup' || mode === 'reset') && !pwDisabledLogin;
  const submitLabel =
    mode === 'login' ? 'Sign in'
    : mode === 'signup' ? 'Sign up'
    : mode === 'forgot' ? 'Send reset link'
    : 'Update password';

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <h1 className="auth-title">Tagwerke</h1>
        <p className="auth-sub">{title}</p>

        {showEmail && (
          <label className="auth-field">
            <span>email</span>
            <input
              type="email"
              autoComplete="email webauthn"
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

        {!pwDisabledLogin && (
          <button className="btn primary auth-submit" type="submit" disabled={busy}>
            {busy ? '…' : submitLabel}
          </button>
        )}

        {mode === 'login' && (pkSupported || sso?.enabled) && (
          <>
            {!pwDisabledLogin && <div className="auth-divider"><span>or</span></div>}
            {pkSupported && (
              <button type="button" className="btn auth-sso auth-passkey" disabled={pkBusy} onClick={doPasskey}>
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden><circle cx="9" cy="8" r="4" fill="none" stroke="currentColor" strokeWidth="1.6"/><path d="M9 13c-3 0-5 2-5 4v1h7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/><circle cx="16.5" cy="12.5" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.6"/><path d="M16.5 15v4l1.2 1-1.2 1" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/></svg>
                {pkBusy ? 'Waiting…' : 'Sign in with a passkey'}
              </button>
            )}
            {sso?.enabled && (
              <>
                {/* Enforced-SSO mode hides the password signup form, so a first-time user has
                    nowhere else to present an invite — offer an optional code beside the button. */}
                {pwDisabledLogin && (
                  <label className="auth-field">
                    <span>invite code</span>
                    <input
                      type="text"
                      value={inviteCode}
                      onChange={(e) => setInviteCode(e.target.value)}
                      placeholder="only if you’re joining for the first time"
                    />
                  </label>
                )}
                <button type="button" className="btn auth-sso" onClick={startSso}>
                  Sign in with {sso.buttonLabel}
                </button>
              </>
            )}
          </>
        )}

        {mode === 'signup' && sso?.enabled && (
          <>
            <div className="auth-divider"><span>or</span></div>
            <button type="button" className="btn auth-sso" onClick={startSso}>
              Sign up with {sso.buttonLabel}
            </button>
          </>
        )}

        {mode === 'login' && !pwDisabledLogin && (
          <button type="button" className="auth-toggle" onClick={() => goto('forgot')}>
            Forgot your password?
          </button>
        )}

        {!pwDisabledLogin && (
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
        )}
      </form>
    </div>
  );
}
