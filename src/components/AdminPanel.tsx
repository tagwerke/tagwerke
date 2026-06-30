// Platform-admin dashboard: list users (promote/demote), and mint/revoke signup
// invites. Visible only to admins (gated in TopBar); the API is admin-gated too.

import { useEffect, useState } from 'react';
import { api, ApiError, type AdminInvite, type AdminUser } from '../api/client';
import { useSession } from '../session/useSession';

export function AdminPanel({ onClose }: { onClose: () => void }) {
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

  async function refresh() {
    try {
      const [u, i] = await Promise.all([api.admin.users(), api.admin.invites()]);
      setUsers(u.users);
      setInvites(i.invites);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'failed to load');
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
    <div className="modal-backdrop" onClick={onClose}>
      <div className="share-panel admin-panel" onClick={(e) => e.stopPropagation()}>
        <header className="share-head">
          <strong>Admin</strong>
          <button className="icon-btn" onClick={onClose} aria-label="close">✕</button>
        </header>

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
      </div>
    </div>
  );
}
