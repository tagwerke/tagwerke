// The three forms behind the Secrets view: an entry (new / edit), a one-time link, and the board's
// network policy. Each takes a `run` from SecretsView that wraps its write in the step-up retry, so
// none of them has to know about sudo.

import { useState, type FormEvent } from 'react';
import type { SecretInput } from '../../api/client';
import { api, ApiError } from '../../api/client';
import { encryptForLink, linkCryptoAvailable, linkUrl } from '../../secrets/linkCrypto';
import type { ID, SecretEntryDTO } from '../../types';
import { useEscape } from './useEscape';

export type Run = <T>(fn: () => Promise<T>) => Promise<T | undefined>;

function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.data?.error ?? `Request failed (${err.status})`;
  return err instanceof Error ? err.message : 'Something went wrong';
}

// ---- entry -------------------------------------------------------------------

export function EntryDialog({
  boardId,
  entry,
  initial,
  run,
  onClose,
  onSaved,
}: {
  boardId: ID;
  /** Present when editing. */
  entry?: SecretEntryDTO;
  /** The revealed values of `entry`, so editing starts from what is stored rather than blanks. */
  initial?: { secret: string; notes?: string };
  run: Run;
  onClose: () => void;
  onSaved: (e: SecretEntryDTO) => void;
}) {
  const [name, setName] = useState(entry?.name ?? '');
  const [username, setUsername] = useState(entry?.username ?? '');
  const [secret, setSecret] = useState(initial?.secret ?? '');
  const [url, setUrl] = useState(entry?.url ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEscape(onClose);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!name.trim() || !secret) return;
    setBusy(true);
    setError(null);
    // Empty optional fields are sent as null so an edit can clear them.
    const body: SecretInput = { name: name.trim(), username: username || null, secret, url: url.trim() || null, notes: notes || null };
    try {
      const saved = await run(() => (entry ? api.secrets.update(entry.id, body) : api.secrets.create(boardId, body)));
      if (saved) onSaved(saved);
      else setBusy(false);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop secret-modal-backdrop" onClick={onClose}>
      <form className="modal secret-modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void submit(e)} autoComplete="off">
        <h2>{entry ? 'Edit secret' : 'New secret'}</h2>
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Stripe — production" autoFocus maxLength={200} />
        </label>
        <label className="field">
          <span>Username</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" maxLength={500} />
        </label>
        <label className="field">
          <span>Secret</span>
          <div className="secret-input-row">
            <input
              type={show ? 'text' : 'password'}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              autoComplete="new-password"
              spellCheck={false}
              maxLength={10_000}
            />
            <button type="button" className="btn ghost tiny" onClick={() => setShow((v) => !v)}>{show ? 'Hide' : 'Show'}</button>
          </div>
        </label>
        <label className="field">
          <span>URL</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" maxLength={2000} />
        </label>
        <label className="field">
          <span>Notes · encrypted too</span>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} spellCheck={false} maxLength={20_000} />
        </label>
        {error && <p className="secret-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !name.trim() || !secret}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </div>
  );
}

// ---- one-time link -------------------------------------------------------------

const TTL_OPTIONS = [
  { label: '1 hour', seconds: 60 * 60 },
  { label: '1 day', seconds: 24 * 60 * 60 },
  { label: '7 days', seconds: 7 * 24 * 60 * 60 },
];

export function ShareDialog({
  boardId,
  entry,
  initialText,
  onClose,
  onCreated,
}: {
  boardId: ID;
  entry?: SecretEntryDTO;
  initialText: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [text, setText] = useState(initialText);
  const [ttl, setTtl] = useState(TTL_OPTIONS[1].seconds);
  const [label, setLabel] = useState(entry ? entry.name : '');
  const [sameNetwork, setSameNetwork] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEscape(onClose);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      const { ciphertext, key } = await encryptForLink(text);
      const { id } = await api.secretLinks.create({
        ciphertext,
        ttlSeconds: ttl,
        pinPrefix: sameNetwork ? 24 : 32,
        label: label.trim() || undefined,
        tabId: boardId,
        entryId: entry?.id,
      });
      // The key never left this tab; it goes straight into the URL fragment.
      setUrl(linkUrl(id, key));
      setText('');
      onCreated();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function copy(): Promise<void> {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      /* selectable by hand */
    }
  }

  return (
    <div className="modal-backdrop secret-modal-backdrop" onClick={onClose}>
      <form className="modal secret-modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void submit(e)} autoComplete="off">
        <h2>One-time link</h2>
        {!linkCryptoAvailable() ? (
          <p className="secret-error">One-time links need this app to be served over HTTPS.</p>
        ) : url ? (
          <>
            <p className="secret-modal-lede">
              Send this to one person. It opens <strong>once</strong>, then it’s gone. Tagwerke never had the key, so nobody
              here can read it, including you, from now on.
            </p>
            <input className="secret-link-url" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={onClose}>Done</button>
              <button type="button" className="btn primary" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy link'}</button>
            </div>
          </>
        ) : (
          <>
            <p className="secret-modal-lede">Encrypted in your browser. The server stores only ciphertext, and the key travels inside the link.</p>
            <label className="field">
              <span>What to send</span>
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} spellCheck={false} autoFocus={!initialText} />
            </label>
            <label className="field">
              <span>Expires after</span>
              <select value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
                {TTL_OPTIONS.map((o) => <option key={o.seconds} value={o.seconds}>{o.label}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Label · only you see this</span>
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. for accounting" maxLength={200} />
            </label>
            <label className="secret-check">
              <input type="checkbox" checked={sameNetwork} onChange={(e) => setSameNetwork(e.target.checked)} />
              <span>Recipient may be on a mobile network. Only warn me about a re-open from a different network, not just a different address.</span>
            </label>
            {error && <p className="secret-error" role="alert">{error}</p>}
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn primary" disabled={busy || !text}>{busy ? 'Encrypting…' : 'Create link'}</button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}

// ---- network policy -------------------------------------------------------------

export function PolicyDialog({
  boardId,
  current,
  clientIp,
  run,
  onClose,
  onSaved,
}: {
  boardId: ID;
  current: string[];
  clientIp: string;
  run: Run;
  onClose: () => void;
  onSaved: (cidrs: string[]) => void;
}) {
  const [text, setText] = useState(current.join('\n'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEscape(onClose);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const cidrs = text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    try {
      const saved = await run(() => api.secrets.setPolicy(boardId, cidrs));
      if (saved) onSaved(saved.allowedCidrs);
      else setBusy(false);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop secret-modal-backdrop" onClick={onClose}>
      <form className="modal secret-modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void submit(e)}>
        <h2>Network access</h2>
        <p className="secret-modal-lede">
          Only allow this board’s secrets to be opened from these addresses: an office range, a VPN exit. One per line,
          as an address (<code>203.0.113.7</code>) or a range (<code>203.0.113.0/24</code>). Leave empty to allow any network.
        </p>
        <label className="field">
          <span>Allowed addresses</span>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} spellCheck={false} className="secret-mono" autoFocus />
        </label>
        <p className="secret-modal-note">
          You are connecting from <code>{clientIp || 'an unknown address'}</code>.{' '}
          {clientIp && (
            <button type="button" className="secret-linkish" onClick={() => setText((t) => (t.trim() ? `${t.trim()}\n${clientIp}` : clientIp))}>
              Add it
            </button>
          )}
        </p>
        {error && <p className="secret-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </div>
  );
}
