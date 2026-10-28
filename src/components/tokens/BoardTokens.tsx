// API tokens for ONE board (PAT_PLAN.md), shown as the board's "Agents" in board settings › People,
// for board admins. The token is for a project's
// agent: it reads this board, and can comment and/or create and edit tasks. It belongs to the board,
// not to whoever made it, and can never mark a task done, delete anything or touch members, settings,
// documents or secrets.

import { useEffect, useState, type FormEvent } from 'react';
import { api, type AgentExtraScope, type BoardToken, type CreatedToken, type TokenDays, TOKEN_DAYS } from '../../api/client';
import { askConfirm } from '../../confirm/useConfirm';
import { timeAgo } from '../../util/dates';
import { TokenSecret } from './TokenSecret';
import { toggled, tokenError, useStepUpRun } from './useStepUpRun';
import { Notice } from '../common/Notice';
import { EmptyState } from '../common/EmptyState';
import { Section } from '../common/Section';

const SCOPES: { key: AgentExtraScope; label: string }[] = [
  { key: 'task:comment', label: 'Comment on tasks' },
  { key: 'task:write', label: 'Create and edit tasks' },
];

const scopeText = (scopes: string[]) =>
  scopes.includes('task:write') ? 'reads, comments, creates and edits tasks'
    : scopes.includes('task:comment') ? 'reads and comments'
      : 'read only';

export function BoardTokens({ tabId, onChange }: { tabId: string; onChange: () => void }) {
  const { run, dialog } = useStepUpRun();
  const [tokens, setTokens] = useState<BoardToken[]>([]);
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [days, setDays] = useState<TokenDays>(90);
  const [scopes, setScopes] = useState<Set<AgentExtraScope>>(new Set(['task:comment']));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedToken | null>(null);

  async function load(): Promise<void> {
    try {
      setTokens((await api.agentTokens.list(tabId)).tokens);
    } catch {
      /* the list is a convenience; creating still works */
    }
  }
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [tabId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function create(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!label.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await run(() => api.agentTokens.create(tabId, { label: label.trim(), scopes: [...scopes], days }));
      if (!res) return; // step-up cancelled
      setCreated(res);
      setOpen(false);
      setLabel('');
      await load();
      onChange(); // the new bot is a board member now
    } catch (err) {
      setError(tokenError(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(t: BoardToken): Promise<void> {
    const ok = await askConfirm({
      title: `Revoke “${t.label ?? 'this token'}”?`,
      body: <p>The agent stops working right away and is removed from this board.</p>,
      confirmLabel: 'Revoke token',
    });
    if (!ok) return;
    try {
      await api.agentTokens.revoke(tabId, t.id);
      await load();
      onChange();
    } catch (err) {
      setError(tokenError(err));
    }
  }

  return (
    <Section
      title="Agents"
      description="An agent works on this board through an API token. It can’t mark tasks done, delete anything or change members or settings."
    >
      {error && <Notice>{error}</Notice>}
      {created && <TokenSecret token={created.token} onDone={() => setCreated(null)} />}

      <ul className="token-list">
        {tokens.map((t) => (
          <li key={t.id} className="token-item">
            <div className="token-main">
              <span className="token-name">{t.label ?? 'token'}</span>
              <span className="token-meta">
                {scopeText(t.scopes)} · {t.expiresAt ? `expires ${new Date(t.expiresAt).toLocaleDateString()}` : 'no expiry'} · {t.lastUsedAt ? `used ${timeAgo(t.lastUsedAt)}` : 'never used'}
              </span>
            </div>
            <button className="row-action danger" onClick={() => void revoke(t)}>Revoke</button>
          </li>
        ))}
        {!tokens.length && <EmptyState as="li">No tokens.</EmptyState>}
      </ul>

      {!open ? (
        <button className="btn ghost security-act" onClick={() => { setOpen(true); setCreated(null); }}>Add an agent</button>
      ) : (
        <form className="token-form" onSubmit={(e) => void create(e)}>
          <label className="field">
            <span>name</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Release bot" maxLength={80} autoFocus />
          </label>
          <label className="field">
            <span>expires</span>
            <select value={days} onChange={(e) => setDays(Number(e.target.value) as TokenDays)}>
              {TOKEN_DAYS.map((d) => <option key={d} value={d}>in {d} days</option>)}
            </select>
          </label>
          <fieldset className="token-fieldset">
            <legend>It reads this board, and also:</legend>
            {SCOPES.map((s) => (
              <label key={s.key} className="board-setting">
                <input type="checkbox" checked={scopes.has(s.key)} onChange={() => setScopes(toggled(scopes, s.key))} />
                {s.label}
              </label>
            ))}
          </fieldset>
          <div className="token-form-actions">
            <button type="button" className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
            <button type="submit" className="btn primary" disabled={busy || !label.trim()}>{busy ? '…' : 'Create token'}</button>
          </div>
        </form>
      )}
      {dialog}
    </Section>
  );
}
