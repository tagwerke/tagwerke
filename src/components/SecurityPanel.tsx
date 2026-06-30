// Account security: enable/disable TOTP two-factor. Enrollment shows a QR + manual key +
// one-time backup codes (shown ONCE), then requires a code to turn 2FA on. Disabling also
// requires a current or backup code. See AUTH_IMPLEMENTATION_PLAN.md (Slice 5).

import { useState } from 'react';
import { useSession } from '../session/useSession';
import { auth } from '../api/client';

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

  const [enroll, setEnroll] = useState<Enroll | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
        </div>
      </div>
    </div>
  );
}
