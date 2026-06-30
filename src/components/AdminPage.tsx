// The /admin page. Reached only by typing the URL (no link anywhere). A non-admin is
// bounced to the app (the API returns 404, so the surface isn't even probeable). Access
// requires a fresh step-up ("sudo") re-auth — see requireSudo on the server.

import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client';
import { navigate } from '../util/router';
import { useSession } from '../session/useSession';
import { AdminConsole } from './AdminConsole';
import { AuditView } from './AuditView';

type Gate = 'checking' | 'need-sudo' | 'ready';
type Tab = 'manage' | 'audit';

export function AdminPage() {
  const totpEnabled = useSession((s) => s.user?.totpEnabled);
  const [gate, setGate] = useState<Gate>('checking');
  const [tab, setTab] = useState<Tab>('manage');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.admin
      .sudoStatus()
      .then((r) => setGate(r.active ? 'ready' : 'need-sudo'))
      .catch((e) => {
        // 404 (not an admin) / 401 (no session) → silently bounce to the app.
        if (e instanceof ApiError && (e.status === 404 || e.status === 401)) navigate('/');
        else setGate('need-sudo');
      });
  }, []);

  async function elevate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.admin.sudo({ password: password || undefined, totp: totp.trim() || undefined });
      setPassword('');
      setTotp('');
      setGate('ready');
    } catch {
      setError('Invalid credentials. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (gate === 'checking') return <div className="app app-loading" />;

  if (gate === 'need-sudo') {
    return (
      <div className="admin-page">
        <form className="admin-sudo auth-card" onSubmit={elevate}>
          <h1 className="auth-title">do</h1>
          <p className="auth-sub">Confirm it’s you to manage the workspace</p>
          <label className="auth-field">
            <span>password</span>
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          </label>
          {totpEnabled && (
            <label className="auth-field">
              <span>two-factor code</span>
              <input inputMode="numeric" value={totp} onChange={(e) => setTotp(e.target.value)} placeholder="6-digit or backup code" />
            </label>
          )}
          {error && <div className="auth-error">{error}</div>}
          <button className="btn primary auth-submit" type="submit" disabled={busy}>{busy ? '…' : 'Continue'}</button>
          <button type="button" className="auth-toggle" onClick={() => navigate('/')}>Back to app</button>
        </form>
      </div>
    );
  }

  return (
    <div className="admin-page">
      <header className="admin-page-head">
        <button className="back-btn" onClick={() => navigate('/')} aria-label="back to app">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="M10 3L4 8l6 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none"/></svg>
          <span>app</span>
        </button>
        <strong className="admin-page-title">Admin</strong>
        <nav className="admin-tabs">
          <button className={tab === 'manage' ? 'is-active' : ''} onClick={() => setTab('manage')}>Manage</button>
          <button className={tab === 'audit' ? 'is-active' : ''} onClick={() => setTab('audit')}>Audit log</button>
        </nav>
      </header>
      <div className="admin-page-body">{tab === 'manage' ? <AdminConsole /> : <AuditView />}</div>
    </div>
  );
}
