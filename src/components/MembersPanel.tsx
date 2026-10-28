// Board settings › People: the board's access list. Admins invite people by email, change roles
// and remove members; anyone can see the roster and leave. Each person's row also says when they
// last edited or looked at the board (the board_activity presence the old Activity tab showed as a
// separate list of the same people). The board's agents follow, in BoardTokens.
//
// Member mutations are independent of the document write-queue, so they call the API
// directly and re-fetch the roster. Leaving a board you can no longer see triggers a
// full reload to re-pull authoritative state.

import { useEffect, useState } from 'react';
import { api, drain, ApiError, type BoardActivityRow, type BoardMember, type BoardRole } from '../api/client';
import { askConfirm } from '../confirm/useConfirm';
import { confirmLeaveBoard } from '../confirm/prompts';
import { useSession } from '../session/useSession';
import { timeAgo } from '../util/dates';
import { EmailLookup } from './EmailLookup';
import { BoardTokens } from './tokens/BoardTokens';
import { Notice } from './common/Notice';
import { Section } from './common/Section';
import { EmptyState, Loading } from './common/EmptyState';

const ROLES: BoardRole[] = ['viewer', 'editor', 'admin'];
const RANK: Record<BoardRole, number> = { viewer: 0, editor: 1, admin: 2 };

/** "edited 2h ago" / "seen 3d ago" — whichever is more recent. ISO strings compare lexicographically. */
function lastActive(row: BoardActivityRow | undefined): string | null {
  if (!row) return null;
  const edited = row.lastEditedAt;
  const seen = row.lastSeenAt;
  if (edited && (!seen || edited > seen)) return `edited ${timeAgo(edited)}`;
  return seen ? `seen ${timeAgo(seen)}` : null;
}

export function MembersPanel({ tabId, tabName }: { tabId: string; tabName: string }) {
  const me = useSession((s) => s.user);
  const [members, setMembers] = useState<BoardMember[] | null>(null);
  const [activity, setActivity] = useState<Record<string, BoardActivityRow>>({});
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<BoardRole>('editor');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    // Presence is best-effort: a failure just leaves the rows without a "last seen".
    let alive = true;
    void api.activity
      .get(tabId)
      .then((r) => {
        if (alive && r) setActivity(Object.fromEntries(r.activity.map((a) => [a.userId, a])));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [tabId]); // eslint-disable-line react-hooks/exhaustive-deps

  const myRole = members?.find((m) => m.userId === me?.id)?.role;
  const isAdmin = myRole === 'admin';
  const people = members?.filter((m) => m.kind !== 'agent');
  const agents = members?.filter((m) => m.kind === 'agent');
  const admins = members?.filter((m) => m.role === 'admin' && m.kind !== 'agent' && m.userId !== me?.id).map((m) => m.email) ?? [];

  // People already on this board — hidden from the lookup (adding them would 409 anyway).
  const currentEmails = new Set((members ?? []).map((m) => m.email.toLowerCase()));

  // A role change takes effect on the target's LIVE sockets (see applyBoardAccessChange), so the
  // two directions that actually move power get a confirm: losing access, and gaining admin.
  // Lateral/expected changes (viewer → editor) go straight through.
  async function changeRole(m: BoardMember, next: BoardRole) {
    if (next === m.role) return;
    const demotion = RANK[next] < RANK[m.role];
    const ok =
      !demotion && next !== 'admin'
        ? true
        : await askConfirm(
            demotion
              ? {
                  title: `Change ${m.email} to ${next}?`,
                  body: (
                    <p>
                      They lose <strong>{m.role}</strong> access to this board right away, including in any
                      session they already have open.
                    </p>
                  ),
                  confirmLabel: `Make ${next}`,
                }
              : {
                  title: `Make ${m.email} an admin?`,
                  body: <p>Admins can add and remove members, change roles, and delete this board.</p>,
                  confirmLabel: 'Make admin',
                  danger: false,
                },
          );
    if (!ok) {
      // The <select> is controlled by `members`, which a cancel leaves untouched — so nothing would
      // re-render and the dropdown would keep showing the role we didn't apply. Nudge state to make
      // React reconcile it back to the real value.
      setMembers((prev) => (prev ? [...prev] : prev));
      return;
    }
    await run(() => api.members.setRole(tabId, m.userId, next));
  }

  async function removeMember(m: BoardMember, self: boolean) {
    const ok = self
      ? await confirmLeaveBoard(tabName)
      : await askConfirm({
          title: 'Remove this member?',
          body: (
            <p>
              <strong>{m.email}</strong> loses access to “{tabName}” immediately, and is disconnected from
              any session they have open on it.
            </p>
          ),
          confirmLabel: 'Remove',
        });
    if (!ok) return;
    await run(() => api.members.remove(tabId, m.userId), self ? () => window.location.reload() : undefined);
  }

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
    <>
      {error && <Notice>{error}</Notice>}

      <Section
        title="People"
        description={
          !people ? undefined
            : isAdmin ? `${people.length} on this board. A role takes effect right away, even in sessions already open.`
              : `${people.length} on this board. Only board admins can invite people or change roles${admins.length ? ` — ask ${admins.join(' or ')}` : ''}.`
        }
      >
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
              placeholder="invite by email…"
            />
            <select value={role} onChange={(e) => setRole(e.target.value as BoardRole)} disabled={busy} aria-label="Role for the new member">
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <button type="submit" disabled={busy || !email.trim()}>Invite</button>
          </form>
        )}

        <ul className="share-members">
          {people?.map((m) => {
            const self = m.userId === me?.id;
            const active = lastActive(activity[m.userId]);
            return (
              <li key={m.userId} className="share-member">
                <span className="share-email">
                  {m.email}{self && <em> (you)</em>}
                  {active && <em> · {active}</em>}
                </span>
                {isAdmin && !self ? (
                  <select
                    value={m.role}
                    disabled={busy}
                    onChange={(e) => void changeRole(m, e.target.value as BoardRole)}
                    aria-label={`Role for ${m.email}`}
                  >
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                ) : (
                  <span className="share-role">{m.role}</span>
                )}
                {(isAdmin || self) && (
                  <button
                    className="row-action danger"
                    disabled={busy}
                    title={self ? 'leave board' : 'remove'}
                    onClick={() => void removeMember(m, self)}
                  >
                    {self ? 'Leave' : 'Remove'}
                  </button>
                )}
              </li>
            );
          })}
          {people && people.length === 0 && <EmptyState as="li">No members.</EmptyState>}
          {!people && <Loading as="li" />}
        </ul>
      </Section>

      {/* Agents are members too (a board token's bot), but their tokens are an admin's to manage, so
          everyone else gets the read-only list. */}
      {isAdmin ? (
        <BoardTokens tabId={tabId} onChange={() => void refresh()} />
      ) : (
        agents && agents.length > 0 && (
          <Section title="Agents" description="Agents work on this board through an API token that a board admin manages.">
            <ul className="share-members">
              {agents.map((m) => (
                <li key={m.userId} className="share-member">
                  <span className="share-email">{m.email}</span>
                  <span className="pill pill-caps bot-badge">bot</span>
                </li>
              ))}
            </ul>
          </Section>
        )
      )}
    </>
  );
}
