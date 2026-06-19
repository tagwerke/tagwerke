// Board access-list UI ("Share"). Lists members, lets an admin add existing users by
// email, change roles, and remove members. Any member can see the roster and leave.
//
// Member mutations are independent of the document write-queue, so they call the API
// directly and re-fetch the roster. Leaving a board you can no longer see triggers a
// full reload to re-pull authoritative state.

import { useEffect, useState } from 'react';
import { api, ApiError, type BoardMember, type BoardRole } from '../api/client';
import { useSession } from '../session/useSession';

const ROLES: BoardRole[] = ['viewer', 'editor', 'admin'];

export function SharePanel({ tabId, tabName, onClose }: { tabId: string; tabName: string; onClose: () => void }) {
  const me = useSession((s) => s.user);
  const [members, setMembers] = useState<BoardMember[] | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<BoardRole>('editor');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const { members } = await api.members.list(tabId);
      setMembers(members);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'failed to load members');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [tabId]); // eslint-disable-line react-hooks/exhaustive-deps

  const myRole = members?.find((m) => m.userId === me?.id)?.role;
  const isAdmin = myRole === 'admin';

  async function run(fn: () => Promise<unknown>, after?: () => void) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (after) after();
      else await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message.replace(/^.*-> \d+\s*/, '') : 'action failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="share-panel" onClick={(e) => e.stopPropagation()}>
        <header className="share-head">
          <strong>Share “{tabName}”</strong>
          <button className="icon-btn" onClick={onClose} aria-label="close">✕</button>
        </header>

        {error && <div className="share-error">{error}</div>}

        <ul className="share-members">
          {members?.map((m) => {
            const self = m.userId === me?.id;
            return (
              <li key={m.userId} className="share-member">
                <span className="share-email">{m.email}{self && <em> (you)</em>}</span>
                {isAdmin && !self ? (
                  <select
                    value={m.role}
                    disabled={busy}
                    onChange={(e) => run(() => api.members.setRole(tabId, m.userId, e.target.value as BoardRole))}
                  >
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                ) : (
                  <span className="share-role">{m.role}</span>
                )}
                {(isAdmin || self) && (
                  <button
                    className="icon-btn"
                    disabled={busy}
                    title={self ? 'leave board' : 'remove'}
                    onClick={() =>
                      run(
                        () => api.members.remove(tabId, m.userId),
                        self ? () => window.location.reload() : undefined,
                      )
                    }
                  >
                    {self ? 'Leave' : '✕'}
                  </button>
                )}
              </li>
            );
          })}
          {members && members.length === 0 && <li className="share-empty">No members.</li>}
          {!members && <li className="share-empty">Loading…</li>}
        </ul>

        {isAdmin && (
          <form
            className="share-add"
            onSubmit={(e) => {
              e.preventDefault();
              if (!email.trim()) return;
              run(() => api.members.add(tabId, email.trim(), role), () => {
                setEmail('');
                void refresh();
              });
            }}
          >
            <input
              type="email"
              placeholder="add by email…"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
            />
            <select value={role} onChange={(e) => setRole(e.target.value as BoardRole)} disabled={busy}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <button type="submit" disabled={busy || !email.trim()}>Add</button>
          </form>
        )}
      </div>
    </div>
  );
}
