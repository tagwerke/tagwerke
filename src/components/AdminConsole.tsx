// Admin "Manage" tab (embedded in AdminPage): users (promote/demote, (de)activate),
// signup invites, and SSO (OIDC) config. All endpoints are admin + sudo gated server-side.

import { useEffect, useState } from 'react';
import { api, ApiError, type AdminInvite, type AdminUser, type OidcConfig } from '../api/client';
import { useSession } from '../session/useSession';

export function AdminConsole() {
  const me = useSession((s) => s.user);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [invites, setInvites] = useState<AdminInvite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // New-invite form.
  const [uses, setUses] = useState(1);
  const [days, setDays] = useState<number | ''>('');
  const [note, setNote] = useState('');
  const [minted, setMinted] = useState<string | null>(null);

  // SSO (OIDC) config form.
  const [oidc, setOidc] = useState<OidcConfig>({});
  const [ssoOnly, setSsoOnly] = useState(false);

  async function refresh() {
    try {
      const [u, i, c] = await Promise.all([api.admin.users(), api.admin.invites(), api.admin.orgConfig()]);
      setUsers(u.users);
      setInvites(i.invites);
      setOidc(c.config.oidc ?? {});
      setSsoOnly(!!c.config.ssoOnly);
    } catch (e) {
      setError(e instanceof ApiError ? e.message.replace(/^.*-> \d+\s*/, '') : 'failed to load');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, []);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message.replace(/^.*-> \d+\s*/, '') : 'action failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-console">
      {error && <div className="share-error">{error}</div>}

      <section className="admin-section">
        <h4>Invites</h4>
        {minted && (
          <div className="admin-minted">
            New code: <code>{minted}</code> <span>— share this to let someone sign up.</span>
          </div>
        )}
        <form
          className="events-add"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const inv = await api.admin.createInvite({
                maxUses: uses,
                days: days === '' ? null : Number(days),
                note: note.trim() || null,
              });
              setMinted(inv.code);
              setNote('');
            });
          }}
        >
          <input type="number" min={1} max={1000} value={uses} onChange={(e) => setUses(Number(e.target.value))} title="max uses" disabled={busy} style={{ width: 70 }} />
          <input type="number" min={1} placeholder="days (∞)" value={days} onChange={(e) => setDays(e.target.value === '' ? '' : Number(e.target.value))} title="expires in days" disabled={busy} style={{ width: 90 }} />
          <input type="text" placeholder="note" value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} />
          <button type="submit" disabled={busy}>Mint</button>
        </form>
        <ul className="share-members">
          {invites?.map((inv) => (
            <li key={inv.code} className="share-member">
              <span className="share-email"><code>{inv.code}</code> <em>{inv.usedCount ?? 0}/{inv.maxUses} used{inv.note ? ` · ${inv.note}` : ''}{inv.expiresAt ? ` · exp ${inv.expiresAt.slice(0, 10)}` : ''}</em></span>
              <button className="icon-btn" disabled={busy} title="revoke" onClick={() => run(() => api.admin.revokeInvite(inv.code))}>✕</button>
            </li>
          ))}
          {invites && invites.length === 0 && <li className="share-empty">No invites.</li>}
          {!invites && <li className="share-empty">Loading…</li>}
        </ul>
      </section>

      <section className="admin-section">
        <h4>Users</h4>
        <ul className="share-members">
          {users?.map((u) => {
            const self = u.id === me?.id;
            const deactivated = !!u.deactivatedAt;
            return (
              <li key={u.id} className={`share-member ${deactivated ? 'is-deactivated' : ''}`}>
                <span className="share-email">
                  {u.email}{self && <em> (you)</em>}{deactivated && <em> · deactivated</em>}
                </span>
                {self ? (
                  <span className="share-role">{u.role}</span>
                ) : (
                  <>
                    <select
                      value={u.role}
                      disabled={busy || deactivated}
                      onChange={(e) => run(() => api.admin.setRole(u.id, e.target.value as 'admin' | 'member'))}
                    >
                      <option value="member">member</option>
                      <option value="admin">admin</option>
                    </select>
                    <button className="link-btn" disabled={busy} title="Clear this user's 2FA (lost authenticator)" onClick={() => run(() => api.admin.resetTwoFactor(u.id))}>reset 2FA</button>
                    <button className="link-btn" disabled={busy} title="Remove this user's passkeys (lost devices)" onClick={() => run(() => api.admin.resetPasskeys(u.id))}>reset passkeys</button>
                    <button
                      className="icon-btn"
                      disabled={busy}
                      title={deactivated ? 'reactivate' : 'deactivate'}
                      onClick={() => run(() => api.admin.setActive(u.id, deactivated))}
                    >
                      {deactivated ? '↺' : '⏻'}
                    </button>
                  </>
                )}
              </li>
            );
          })}
          {!users && <li className="share-empty">Loading…</li>}
        </ul>
      </section>

      <section className="admin-section">
        <h4>SSO (OIDC)</h4>
        <div className="sso-form">
          <label className="sso-row sso-check">
            <input type="checkbox" checked={!!oidc.enabled} disabled={busy} onChange={(e) => setOidc({ ...oidc, enabled: e.target.checked })} />
            <span>Enabled</span>
          </label>
          <label className="sso-row">
            <span>Issuer URL</span>
            <input type="url" value={oidc.issuer ?? ''} disabled={busy} placeholder="https://accounts.google.com" onChange={(e) => setOidc({ ...oidc, issuer: e.target.value })} />
          </label>
          <label className="sso-row">
            <span>Client ID</span>
            <input value={oidc.clientId ?? ''} disabled={busy} onChange={(e) => setOidc({ ...oidc, clientId: e.target.value })} />
          </label>
          <label className="sso-row">
            <span>Client secret</span>
            <input type="password" value={oidc.clientSecret ?? ''} disabled={busy} placeholder="leave unchanged" onChange={(e) => setOidc({ ...oidc, clientSecret: e.target.value })} />
          </label>
          <label className="sso-row">
            <span>Allowed email domain</span>
            <input value={oidc.allowedDomain ?? ''} disabled={busy} placeholder="knyazev.ca" onChange={(e) => setOidc({ ...oidc, allowedDomain: e.target.value })} />
          </label>
          <label className="sso-row">
            <span>Button label</span>
            <input value={oidc.buttonLabel ?? ''} disabled={busy} placeholder="Google" onChange={(e) => setOidc({ ...oidc, buttonLabel: e.target.value })} />
          </label>
          <label className="sso-row sso-check">
            <input type="checkbox" checked={ssoOnly} disabled={busy} onChange={(e) => setSsoOnly(e.target.checked)} />
            <span>Enforce SSO-only (disable password login)</span>
          </label>
          <p className="sso-hint">Redirect URI to register at your IdP: <code>{window.location.origin}/api/auth/oidc/callback</code></p>
          <button className="btn primary" disabled={busy} onClick={() => run(() => api.admin.setOrgConfig({ oidc, ssoOnly }))}>Save SSO settings</button>
        </div>
      </section>
    </div>
  );
}
