// A board's Secrets view (SECRET_LINKS_PLAN.md, reshaped to "boards with secrets").
//
// Board admins only; the server enforces that (and the board's network policy, and the step-up) on
// every request, and this view only mirrors it. What it must NOT do is put a revealed value anywhere
// durable: values live in this component's state, are dropped after REVEAL_MS, and never touch the
// store, the outbox or the offline snapshot.
//
// The step-up is reactive rather than up-front: a write or reveal that answers `401 sudo required`
// opens the confirm dialog and, on success, retries once. The list itself needs no step-up, so the
// view opens without asking for a password just to show names.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { askConfirm } from '../../confirm/useConfirm';
import { timeAgo as timeAgoIso } from '../../util/dates';
import type { ID, SecretEntryDTO, SecretLinkDTO } from '../../types';
import { StepUpDialog } from './StepUpDialog';
import { EntryDialog, PolicyDialog, ShareDialog, type Run } from './SecretDialogs';
import { EmptyState, Loading } from '../common/EmptyState';

/** How long a revealed value stays on screen before it is dropped from memory. */
const REVEAL_MS = 30_000;

type Load =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'off'; detail?: string }
  | { kind: 'blocked'; ip?: string }
  | { kind: 'error'; message: string };

type Dialog =
  | { kind: 'new' }
  | { kind: 'edit'; entry: SecretEntryDTO; initial: { secret: string; notes?: string } }
  | { kind: 'share'; entry?: SecretEntryDTO; text: string }
  | { kind: 'policy' }
  | null;

interface Revealed {
  secret: string;
  notes?: string;
}

const isSudoRequired = (e: unknown) => e instanceof ApiError && e.status === 401 && e.data?.error === 'sudo required';

function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.data?.error ?? `Request failed (${err.status})`;
  return err instanceof Error ? err.message : 'Something went wrong';
}

const timeAgo = (ms: number) => timeAgoIso(new Date(ms).toISOString());

function safeHref(url: string | undefined): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

export function SecretsView({ boardId }: { boardId: ID }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [entries, setEntries] = useState<SecretEntryDTO[]>([]);
  const [policy, setPolicy] = useState<string[]>([]);
  const [clientIp, setClientIp] = useState('');
  const [links, setLinks] = useState<SecretLinkDTO[]>([]);
  const [revealed, setRevealed] = useState<Record<ID, Revealed>>({});
  const [busyId, setBusyId] = useState<ID | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState<((ok: boolean) => void) | null>(null);
  const timers = useRef(new Map<ID, number>());

  const refresh = useCallback(async () => {
    try {
      const r = await api.secrets.list(boardId);
      setEntries(r.entries);
      setPolicy(r.policy.allowedCidrs);
      setClientIp(r.clientIp);
      setLoad({ kind: 'ready' });
    } catch (err) {
      if (err instanceof ApiError && err.data?.code === 'vault_off') setLoad({ kind: 'off', detail: err.data.detail as string | undefined });
      else if (err instanceof ApiError && err.data?.code === 'ip_not_allowed') setLoad({ kind: 'blocked', ip: err.data.ip as string | undefined });
      else setLoad({ kind: 'error', message: errorText(err) });
      return;
    }
    api.secretLinks.list(boardId).then((r) => setLinks(r.links)).catch(() => {});
  }, [boardId]);

  useEffect(() => {
    // Fetch-on-mount; every setState in refresh() lands after an await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  // Leaving the view drops every revealed value and its timer.
  useEffect(() => {
    const t = timers.current;
    return () => {
      for (const id of t.values()) window.clearTimeout(id);
      t.clear();
    };
  }, []);

  /** Run a request; on `sudo required`, ask for the step-up and retry once. Undefined = cancelled. */
  const run: Run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err) {
      if (!isSudoRequired(err)) throw err;
    }
    const ok = await new Promise<boolean>((resolve) => setStepUp(() => resolve));
    setStepUp(null);
    if (!ok) return undefined;
    return fn();
  }, []);

  function hide(id: ID): void {
    const t = timers.current.get(id);
    if (t) window.clearTimeout(t);
    timers.current.delete(id);
    setRevealed((r) => {
      const next = { ...r };
      delete next[id];
      return next;
    });
  }

  async function fetchValue(entry: SecretEntryDTO): Promise<Revealed | undefined> {
    setBusyId(entry.id);
    setNotice(null);
    try {
      return await run(() => api.secrets.reveal(entry.id));
    } catch (err) {
      setNotice(errorText(err));
      if (err instanceof ApiError && err.data?.code === 'ip_not_allowed') void refresh();
      return undefined;
    } finally {
      setBusyId(null);
    }
  }

  async function reveal(entry: SecretEntryDTO): Promise<void> {
    if (revealed[entry.id]) return hide(entry.id);
    const value = await fetchValue(entry);
    if (!value) return;
    setRevealed((r) => ({ ...r, [entry.id]: value }));
    timers.current.set(entry.id, window.setTimeout(() => hide(entry.id), REVEAL_MS));
  }

  async function edit(entry: SecretEntryDTO): Promise<void> {
    const value = revealed[entry.id] ?? (await fetchValue(entry));
    if (value) setDialog({ kind: 'edit', entry, initial: value });
  }

  async function share(entry: SecretEntryDTO): Promise<void> {
    const value = revealed[entry.id] ?? (await fetchValue(entry));
    if (!value) return;
    const text = entry.username ? `${entry.username}\n${value.secret}` : value.secret;
    setDialog({ kind: 'share', entry, text });
  }

  async function remove(entry: SecretEntryDTO): Promise<void> {
    const ok = await askConfirm({
      title: `Delete “${entry.name}”?`,
      body: <p>The secret is destroyed for everyone on this board. There is no Trash for secrets, so it cannot be restored.</p>,
      confirmLabel: 'Delete secret',
    });
    if (!ok) return;
    try {
      const done = await run(() => api.secrets.remove(entry.id));
      if (done === undefined) return;
      hide(entry.id);
      setEntries((list) => list.filter((e) => e.id !== entry.id));
    } catch (err) {
      setNotice(errorText(err));
    }
  }

  async function revoke(link: SecretLinkDTO): Promise<void> {
    try {
      await api.secretLinks.revoke(link.id);
      setLinks((l) => l.filter((x) => x.id !== link.id));
    } catch (err) {
      setNotice(errorText(err));
    }
  }

  async function copy(key: string, text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      setNotice('Couldn’t reach the clipboard. Select the text and copy it by hand.');
    }
  }

  // ---- states that are not the list --------------------------------------------
  if (load.kind !== 'ready') {
    return (
      <section className="secrets-card">
        <header className="secrets-head"><span className="secrets-title">Secrets</span></header>
        {load.kind === 'loading' ? (
          <Loading as="p" />
        ) : load.kind === 'off' ? (
          <EmptyState size="block" as="p">
            Secrets aren’t enabled on this instance{load.detail ? <>: <code>{load.detail}</code></> : '.'} An operator has to
            set a valid <code>VAULT_KEY</code> on the server and restart it (see .env.example).
          </EmptyState>
        ) : load.kind === 'blocked' ? (
          <EmptyState size="block" as="p">
            This board’s secrets can only be opened from approved networks, and you’re connecting from{' '}
            <code>{load.ip ?? 'an address that isn’t on the list'}</code>. Connect through the office network or VPN, or ask
            another board admin to add your address.
          </EmptyState>
        ) : (
          <EmptyState size="block" as="p">
            {load.message} <button className="secret-linkish" onClick={() => void refresh()}>Retry</button>
          </EmptyState>
        )}
      </section>
    );
  }

  const liveLinks = links.filter((l) => l.status === 'waiting' || l.foreignAttemptAt);

  return (
    <>
      <section className="secrets-card">
        <header className="secrets-head">
          <span className="secrets-title">Secrets{entries.length ? ` · ${entries.length}` : ''}</span>
          <button className="btn ghost tiny" onClick={() => setDialog({ kind: 'policy' })} title="Which networks may open these secrets">
            {policy.length ? `Network: ${policy.length} allowed` : 'Network: any'}
          </button>
          <button className="btn ghost tiny" onClick={() => setDialog({ kind: 'share', text: '' })}>One-time link</button>
          <button className="btn primary tiny" onClick={() => setDialog({ kind: 'new' })}>New secret</button>
        </header>
        <p className="secrets-sub">
          Visible to board admins only. Values are encrypted on the server, every reveal is logged, and opening one asks you to
          confirm it’s you.
        </p>
        {notice && <p className="secret-error" role="status">{notice}</p>}

        {entries.length === 0 ? (
          <EmptyState size="block" as="p">No secrets yet. Credentials in a note or a task are readable by everyone on the board, so they belong here.</EmptyState>
        ) : (
          <ul className="secret-list">
            {entries.map((e) => {
              const v = revealed[e.id];
              const href = safeHref(e.url);
              const busy = busyId === e.id;
              return (
                <li key={e.id} className="secret-row">
                  <div className="secret-row-main">
                    <span className="secret-name">{e.name}</span>
                    <span className="secret-meta">
                      {e.username && (
                        <button className="secret-chip" onClick={() => void copy(`u:${e.id}`, e.username!)} title="Copy username">
                          {copied === `u:${e.id}` ? 'copied' : e.username}
                        </button>
                      )}
                      {href ? (
                        <a className="secret-url" href={href} target="_blank" rel="noopener noreferrer">{e.url}</a>
                      ) : e.url ? (
                        <span className="secret-url">{e.url}</span>
                      ) : null}
                      <span className="secret-when">updated {timeAgo(e.updatedAt)}</span>
                    </span>
                    {v && (
                      <div className="secret-value">
                        <code className="secret-mono">{v.secret}</code>
                        <button className="btn ghost tiny" onClick={() => void copy(`s:${e.id}`, v.secret)}>
                          {copied === `s:${e.id}` ? 'Copied' : 'Copy'}
                        </button>
                        {v.notes && <pre className="secret-notes">{v.notes}</pre>}
                        <span className="secret-when">hides again after 30 seconds</span>
                      </div>
                    )}
                  </div>
                  <span className="secret-actions">
                    <button className="btn ghost tiny" disabled={busy} onClick={() => void reveal(e)}>{busy ? '…' : v ? 'Hide' : 'Reveal'}</button>
                    <button className="btn ghost tiny" disabled={busy} onClick={() => void share(e)} title="Send as a one-time link">Share</button>
                    <button className="btn ghost tiny" disabled={busy} onClick={() => void edit(e)}>Edit</button>
                    <button className="btn ghost tiny secret-delete" disabled={busy} onClick={() => void remove(e)} aria-label={`delete ${e.name}`}>Delete</button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {liveLinks.length > 0 && (
        <section className="secrets-card">
          <header className="secrets-head"><span className="secrets-title">Your one-time links</span></header>
          <ul className="secret-list">
            {liveLinks.map((l) => (
              <li key={l.id} className="secret-row">
                <div className="secret-row-main">
                  <span className="secret-name">{l.label || 'Unlabelled link'}</span>
                  <span className="secret-meta">
                    {l.status === 'waiting' ? (
                      <span className="secret-when">not opened yet · expires {new Date(l.expiresAt).toLocaleString()}</span>
                    ) : (
                      <span className="secret-when">opened {l.viewedAt ? timeAgo(l.viewedAt) : ''}</span>
                    )}
                    {l.foreignAttemptAt && (
                      <span className="secret-warn">
                        Someone on another network tried to open it after it was read ({timeAgo(l.foreignAttemptAt)}). If the
                        recipient didn’t, assume it leaked and rotate the secret.
                      </span>
                    )}
                  </span>
                </div>
                {l.status === 'waiting' && (
                  <span className="secret-actions">
                    <button className="btn ghost tiny" onClick={() => void revoke(l)}>Revoke</button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {dialog?.kind === 'new' && (
        <EntryDialog
          boardId={boardId}
          run={run}
          onClose={() => setDialog(null)}
          onSaved={(e) => {
            setEntries((list) => [...list, e].sort((a, b) => a.name.localeCompare(b.name)));
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === 'edit' && (
        <EntryDialog
          boardId={boardId}
          entry={dialog.entry}
          initial={dialog.initial}
          run={run}
          onClose={() => setDialog(null)}
          onSaved={(e) => {
            hide(e.id);
            setEntries((list) => list.map((x) => (x.id === e.id ? e : x)));
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === 'share' && (
        <ShareDialog
          boardId={boardId}
          entry={dialog.entry}
          initialText={dialog.text}
          onClose={() => setDialog(null)}
          onCreated={() => void api.secretLinks.list(boardId).then((r) => setLinks(r.links)).catch(() => {})}
        />
      )}
      {dialog?.kind === 'policy' && (
        <PolicyDialog
          boardId={boardId}
          current={policy}
          clientIp={clientIp}
          run={run}
          onClose={() => setDialog(null)}
          onSaved={(cidrs) => {
            setPolicy(cidrs);
            setDialog(null);
          }}
        />
      )}
      {stepUp && <StepUpDialog onDone={stepUp} />}
    </>
  );
}
