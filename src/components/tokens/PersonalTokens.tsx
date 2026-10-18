// Personal access tokens (PAT_PLAN.md), in Security. A token acts as YOU on the normal API, limited to
// the permissions and boards ticked here — for your own scripts and agents. Reading the ticked boards
// is implied; the checkboxes cover writing only. Nothing is ticked by default.

import { useEffect, useState, type FormEvent } from 'react';
import { api, type CreatedToken, type PatScope, type PersonalToken, type TokenDays, TOKEN_DAYS } from '../../api/client';
import { askConfirm } from '../../confirm/useConfirm';
import { useStore } from '../../store';
import { timeAgo } from '../../util/dates';
import { TokenSecret } from './TokenSecret';
import { toggled, tokenError, useStepUpRun } from './useStepUpRun';
import { Notice } from '../common/Notice';
import { EmptyState } from '../common/EmptyState';

const SCOPES: { key: PatScope; label: string }[] = [
  { key: 'tasks', label: 'Create and edit tasks' },
  { key: 'comments', label: 'Comment on tasks' },
  { key: 'boards', label: 'Create boards, rename them and their sprints' },
];


function boardsText(t: PersonalToken, names: Record<string, string>): string {
  if (t.allBoards) return 'all your boards, including future ones';
  if (!t.boardIds.length) return 'no boards';
  return t.boardIds.map((id) => names[id] ?? 'a deleted board').join(', ');
}

export function PersonalTokens() {
  const tabs = useStore((s) => s.tabs);
  const tabOrder = useStore((s) => s.tabOrder);
  const names = Object.fromEntries(Object.values(tabs).map((t) => [t.id, t.name]));
  const { run, dialog } = useStepUpRun();

  const [tokens, setTokens] = useState<PersonalToken[]>([]);
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [days, setDays] = useState<TokenDays>(90);
  const [scopes, setScopes] = useState<Set<PatScope>>(new Set());
  const [allBoards, setAllBoards] = useState(false);
  const [boardIds, setBoardIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedToken | null>(null);

  async function load(): Promise<void> {
    try {
      setTokens((await api.tokens.list()).tokens);
    } catch {
      /* the list is a convenience; creating still works */
    }
  }
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, []);

  async function create(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!label.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await run(() =>
        api.tokens.create({ label: label.trim(), scopes: [...scopes], allBoards, boardIds: allBoards ? [] : [...boardIds], days }),
      );
      if (!res) return; // step-up cancelled
      setCreated(res);
      setOpen(false);
      setLabel('');
      setScopes(new Set());
      setAllBoards(false);
      setBoardIds(new Set());
      await load();
    } catch (err) {
      setError(tokenError(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(t: PersonalToken): Promise<void> {
    const ok = await askConfirm({
      title: `Revoke “${t.label}”?`,
      body: <p>Anything using this token stops working right away. This can’t be undone — create a new token to replace it.</p>,
      confirmLabel: 'Revoke token',
    });
    if (!ok) return;
    try {
      await api.tokens.revoke(t.id);
      await load();
    } catch (err) {
      setError(tokenError(err));
    }
  }

  return (
    <div className="security-tokens">
      <p className="security-status">
        Personal access tokens <span className="security-sub">— let your own scripts and agents act as you, on the boards you choose</span>
      </p>
      {error && <Notice>{error}</Notice>}
      {created && <TokenSecret token={created.token} onDone={() => setCreated(null)} />}

      <ul className="token-list">
        {tokens.map((t) => (
          <li key={t.id} className="token-item">
            <div className="token-main">
              <span className="token-name">{t.label}</span>
              <span className="token-meta">
                {t.scopes.length ? `can ${t.scopes.join(', ')}` : 'read only'} · {boardsText(t, names)}
              </span>
              <span className="token-meta">
                expires {new Date(t.expiresAt).toLocaleDateString()} · {t.lastUsedAt ? `used ${timeAgo(t.lastUsedAt)}${t.lastUsedIp ? ` from ${t.lastUsedIp}` : ''}` : 'never used'}
              </span>
            </div>
            <button className="row-action danger" onClick={() => void revoke(t)}>Revoke</button>
          </li>
        ))}
        {!tokens.length && <EmptyState as="li">No tokens yet.</EmptyState>}
      </ul>

      {!open ? (
        <button className="btn ghost" onClick={() => { setOpen(true); setCreated(null); }}>New token</button>
      ) : (
        <form className="token-form" onSubmit={(e) => void create(e)}>
          <label className="field">
            <span>name</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Chuck’s planning agent" maxLength={80} autoFocus />
          </label>
          <label className="field">
            <span>expires</span>
            <select value={days} onChange={(e) => setDays(Number(e.target.value) as TokenDays)}>
              {TOKEN_DAYS.map((d) => <option key={d} value={d}>in {d} days</option>)}
            </select>
          </label>
          <fieldset className="token-fieldset">
            <legend>It can read the boards below, and also:</legend>
            {SCOPES.map((s) => (
              <label key={s.key} className="board-setting">
                <input type="checkbox" checked={scopes.has(s.key)} onChange={() => setScopes(toggled(scopes, s.key))} />
                {s.label}
              </label>
            ))}
          </fieldset>
          <fieldset className="token-fieldset">
            <legend>Boards</legend>
            <label className="board-setting">
              <input type="checkbox" checked={allBoards} onChange={(e) => setAllBoards(e.target.checked)} />
              All my boards, including future ones
            </label>
            {!allBoards && tabOrder.map((id) => (
              <label key={id} className="board-setting">
                <input type="checkbox" checked={boardIds.has(id)} onChange={() => setBoardIds(toggled(boardIds, id))} />
                {tabs[id]?.name}
              </label>
            ))}
            {!allBoards && !boardIds.size && <span className="security-sub">No boards ticked: the token can’t see any.</span>}
          </fieldset>
          <p className="security-sub">A token never reaches secrets, members, board settings or your account security, whatever is ticked.</p>
          <div className="token-form-actions">
            <button type="button" className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
            <button type="submit" className="btn primary" disabled={busy || !label.trim()}>{busy ? '…' : 'Create token'}</button>
          </div>
        </form>
      )}
      {dialog}
    </div>
  );
}
