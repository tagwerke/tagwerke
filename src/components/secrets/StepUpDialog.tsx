// "Confirm it's you" before a secret is revealed or changed — the same step-up the /admin page uses
// (AdminPage.tsx), on the mount any signed-in user can reach (/api/auth/sudo). A grant lasts ten
// minutes per session, so this asks once per sitting, not once per click.

import { useState, type FormEvent } from 'react';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { api, ApiError } from '../../api/client';
import { useSession } from '../../session/useSession';
import { useEscape } from './useEscape';

export function StepUpDialog({ onDone, reason = 'Secrets need a fresh sign-in. This lasts ten minutes.' }: { onDone: (ok: boolean) => void; reason?: string }) {
  const totpEnabled = useSession((s) => s.user?.totpEnabled);
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEscape(() => onDone(false));

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.stepUp.password({ password: password || undefined, totp: totp.trim() || undefined });
      onDone(true);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? 'Too many attempts. Wait a minute.' : 'That didn’t match. Try again.');
      setBusy(false);
    }
  }

  async function passkey(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.stepUp.passkey();
      onDone(true);
    } catch (err) {
      if (!(err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError'))) {
        setError(err instanceof ApiError && err.status === 400 ? 'You have no passkey registered.' : 'Passkey verification failed.');
      }
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop secret-modal-backdrop" onClick={() => onDone(false)}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void submit(e)}>
        <h2>Confirm it’s you</h2>
        <p className="secret-modal-lede">{reason}</p>
        <label className="field">
          <span>Password</span>
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        </label>
        {totpEnabled && (
          <label className="field">
            <span>Two-factor code</span>
            <input inputMode="numeric" autoComplete="one-time-code" value={totp} onChange={(e) => setTotp(e.target.value)} placeholder="6-digit or backup code" />
          </label>
        )}
        {error && <p className="secret-error" role="alert">{error}</p>}
        <div className="modal-actions">
          {browserSupportsWebAuthn() && (
            <button type="button" className="btn ghost" disabled={busy} onClick={() => void passkey()}>Use a passkey</button>
          )}
          <span className="secret-spacer" />
          <button type="button" className="btn ghost" onClick={() => onDone(false)}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? '…' : 'Continue'}</button>
        </div>
      </form>
    </div>
  );
}
