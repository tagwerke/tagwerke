// Board access-list UI ("Share"). Lists members, lets an admin add existing users by
// email, change roles, and remove members. Any member can see the roster and leave.
//
// Member mutations are independent of the document write-queue, so they call the API
// directly and re-fetch the roster. Leaving a board you can no longer see triggers a
// full reload to re-pull authoritative state.

import { useEffect, useState } from 'react';
import { api, drain, ApiError, type BoardMember, type BoardRole } from '../api/client';
import { useSession } from '../session/useSession';
import { useStore } from '../store';
import { EmailLookup } from './EmailLookup';
import { HistoryDrawer } from './HistoryDrawer';
import { TrashPanel } from './TrashPanel';

const ROLES: BoardRole[] = ['viewer', 'editor', 'admin'];

export function SharePanel({ tabId, tabName, onClose, embedded }: { tabId: string; tabName: string; onClose: () => void; embedded?: boolean }) {
  const me = useSession((s) => s.user);
  const settings = useStore((s) => s.tabs[tabId]?.settings);
  const setTabSettings = useStore((s) => s.setTabSettings);
  const [members, setMembers] = useState<BoardMember[] | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<BoardRole>('editor');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);

  async function refresh() {
    try {
      // A just-created board is optimistic in the store while its POST /api/tabs is still
      // in the durable outbox; the roster GET would 404 (no board_members row yet). Flush
      // pending writes first so the membership row exists server-side before we read it.
      await drain();
      const { members } = await api.members.list(tabId);
      setMembers(members);
      setError(null); // success clears any transient failure so a stale 404 banner doesn't linger
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

  // People already on this board — hidden from the lookup (adding them would 409 anyway).
  const currentEmails = new Set((members ?? []).map((m) => m.email.toLowerCase()));

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

  const body = (
    <>
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
            <EmailLookup
              value={email}
              onChange={setEmail}
              exclude={currentEmails}
              disabled={busy}
              placeholder="add by email…"
            />
            <select value={role} onChange={(e) => setRole(e.target.value as BoardRole)} disabled={busy}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <button type="submit" disabled={busy || !email.trim()}>Add</button>
          </form>
        )}

        {!embedded && (myRole === 'editor' || myRole === 'admin') && (
          <div className="share-footer">
            <button className="btn ghost" onClick={() => setHistoryOpen(true)}>Board history</button>
            <button className="btn ghost" onClick={() => setTrashOpen(true)}>Trash</button>
          </div>
        )}

        {isAdmin && (
          <div className="board-settings">
            <strong>Board settings</strong>
            <label className="board-setting">
              <input
                type="checkbox"
                checked={!!settings?.requireReview}
                onChange={(e) => setTabSettings(tabId, { ...settings, requireReview: e.target.checked })}
              />
              Require review before Done
            </label>
            <label className="board-setting">
              <input
                type="checkbox"
                checked={settings?.restrictDelete === 'admin'}
                onChange={(e) => setTabSettings(tabId, { ...settings, restrictDelete: e.target.checked ? 'admin' : undefined })}
              />
              Only admins can delete
            </label>
          </div>
        )}

        {historyOpen && <HistoryDrawer kind="tab" id={tabId} boardId={tabId} title={tabName} onClose={() => setHistoryOpen(false)} />}
        {trashOpen && <TrashPanel tabId={tabId} tabName={tabName} onClose={() => setTrashOpen(false)} />}
    </>
  );

  if (embedded) return <div className="panel-embed">{body}</div>;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="share-panel" onClick={(e) => e.stopPropagation()}>
        <header className="share-head">
          <strong>Share “{tabName}”</strong>
          <button className="icon-btn" onClick={onClose} aria-label="close">✕</button>
        </header>
        {body}
      </div>
    </div>
  );
}
