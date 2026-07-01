// Account security: enable/disable TOTP two-factor. Enrollment shows a QR + manual key +
// one-time backup codes (shown ONCE), then requires a code to turn 2FA on. Disabling also
// requires a current or backup code. See AUTH_IMPLEMENTATION_PLAN.md (Slice 5).

import { useEffect, useState } from 'react';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { useSession } from '../session/useSession';
import { auth, type PasskeyInfo } from '../api/client';
import { timeAgo } from '../util/dates';

interface Enroll {
  qr: string;
  otpauthUrl: string;
  secret: string;
  backupCodes: string[];
}

export function SecurityPanel({ onClose }: { onClose: () => void }) {
  const user = useSession((s) => s.user);
  const refreshUser = useSession((s) => s.refreshUser);
  const enabled = !!user?.totpEnabled;
  const pkSupported = browserSupportsWebAuthn();

  const [enroll, setEnroll] = useState<Enroll | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [passkeys, setPasskeys] = useState<PasskeyInfo[]>([]);
  const [pkName, setPkName] = useState('');

  const loadPasskeys = async () => {
    try {
      const r = await auth.passkey.list();
      setPasskeys(r.passkeys);
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadPasskeys();
  }, []);

  const addPasskey = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await auth.passkey.register(pkName.trim() || undefined);
      setPkName('');
      await loadPasskeys();
      setNotice('Passkey added.');
    } catch (e) {
      if (!(e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError'))) setError('Could not add that passkey.');
    } finally {
      setBusy(false);
    }
  };
  const removePasskey = (id: string) => run(async () => { await auth.passkey.remove(id); await loadPasskeys(); });
  const renamePasskey = (id: string, current: string) => {
    const name = window.prompt('Rename passkey', current);
    if (name && name.trim()) run(async () => { await auth.passkey.rename(id, name.trim()); await loadPasskeys(); });
  };

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch {
      setError('That didn’t work — check the code and try again.');
    } finally {
      setBusy(false);
    }
  }

  const startEnroll = () =>
    run(async () => {
      const r = await auth.totpEnroll();
      setEnroll({ qr: r.qr, otpauthUrl: r.otpauthUrl, secret: r.secret, backupCodes: r.backupCodes });
    });

  const confirmEnroll = () =>
    run(async () => {
      await auth.totpVerify(code.trim());
      await refreshUser();
      setEnroll(null);
      setCode('');
      setNotice('Two-factor authentication is on.');
    });

  const disable = () =>
    run(async () => {
      await auth.totpDisable(code.trim());
      await refreshUser();
      setCode('');
      setNotice('Two-factor authentication is off.');
    });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="share-panel" onClick={(e) => e.stopPropagation()}>
        <header className="share-head">
          <strong>Security</strong>
          <button className="icon-btn" onClick={onClose} aria-label="close">✕</button>
        </header>

        {notice && <div className="auth-notice">{notice}</div>}
        {error && <div className="share-error">{error}</div>}

        <div className="security-body">
          <p className="security-status">
            Two-factor authentication: <strong>{enabled ? 'On' : 'Off'}</strong>
          </p>

          {!enabled && !enroll && (
            <button className="btn primary" disabled={busy} onClick={startEnroll}>
              Enable two-factor
            </button>
          )}

          {!enabled && enroll && (
            <div className="security-enroll">
              <p>Scan the QR with an authenticator app — or, on this device, add it directly. Then enter a code to confirm.</p>
              <img className="security-qr" src={enroll.qr} alt="TOTP QR code" />
              {/* On phones the QR is on the same device, so offer a direct deep link. */}
              <a className="btn ghost security-add" href={enroll.otpauthUrl}>Add to authenticator app</a>
              <p className="security-secret">
                Or enter this key manually: <code>{enroll.secret}</code>{' '}
                <button type="button" className="link-btn" onClick={() => { void navigator.clipboard?.writeText(enroll.secret); setNotice('Key copied.'); }}>copy</button>
              </p>
              <div className="security-backup">
                <strong>Backup codes</strong> — save these now, each works once:
                <ul>
                  {enroll.backupCodes.map((c) => (
                    <li key={c}><code>{c}</code></li>
                  ))}
                </ul>
              </div>
              <label className="auth-field">
                <span>code</span>
                <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" placeholder="6-digit code" autoFocus />
              </label>
              <button className="btn primary" disabled={busy} onClick={confirmEnroll}>Confirm</button>
            </div>
          )}

          {enabled && (
            <div className="security-disable">
              <label className="auth-field">
                <span>code to disable</span>
                <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" placeholder="current or backup code" />
              </label>
              <button className="btn ghost" disabled={busy} onClick={disable}>Disable two-factor</button>
            </div>
          )}

          <div className="security-passkeys">
            <p className="security-status">Passkeys <span className="security-sub">— sign in with Face ID / fingerprint / a security key</span></p>
            <ul className="passkey-list">
              {passkeys.map((p) => (
                <li key={p.id} className="passkey-item">
                  <span className="passkey-name">{p.nickname}</span>
                  <span className="passkey-meta">added {timeAgo(p.createdAt)}{p.lastUsedAt ? ` · used ${timeAgo(p.lastUsedAt)}` : ''}</span>
                  <button className="link-btn" disabled={busy} onClick={() => renamePasskey(p.id, p.nickname)}>rename</button>
                  <button className="icon-btn" disabled={busy} title="remove passkey" onClick={() => removePasskey(p.id)}>✕</button>
                </li>
              ))}
              {!passkeys.length && <li className="share-empty">No passkeys yet.</li>}
            </ul>
            {pkSupported ? (
              <div className="passkey-add">
                <input value={pkName} onChange={(e) => setPkName(e.target.value)} placeholder="name (optional, e.g. iPhone)" />
                <button className="btn primary" disabled={busy} onClick={addPasskey}>Add a passkey</button>
              </div>
            ) : (
              <p className="security-secret">This browser doesn’t support passkeys.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
