// Account security. Two tabs: Sign-in (passkeys, then TOTP two-factor) and Access tokens.
// Two-factor enrollment is a three-step flow — scan, save the one-time backup codes, confirm a
// code — and the codes (shown ONCE) must be acknowledged before the confirm step. Disabling also
// requires a current or backup code. See AUTH_IMPLEMENTATION_PLAN.md (Slice 5).

import { useEffect, useState } from 'react';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { useSession } from '../session/useSession';
import { askConfirm } from '../confirm/useConfirm';
import { auth, type PasskeyInfo } from '../api/client';
import { timeAgo } from '../util/dates';
import { PersonalTokens } from './tokens/PersonalTokens';
import { Notice } from './common/Notice';
import { EmptyState } from './common/EmptyState';
import { Section } from './common/Section';
import { Tabs } from './common/Segmented';

interface Enroll {
  qr: string;
  otpauthUrl: string;
  secret: string;
  backupCodes: string[];
}

type PanelTab = 'signin' | 'tokens';
type Step = 1 | 2 | 3;

const STEP_LABELS = ['Scan', 'Save codes', 'Confirm'] as const;

function downloadCodes(codes: string[]): void {
  const blob = new Blob([`Tagwerke backup codes — each works once\n\n${codes.join('\n')}\n`], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'tagwerke-backup-codes.txt';
  a.click();
  URL.revokeObjectURL(url);
}

export function SecurityPanel({ onClose }: { onClose: () => void }) {
  const user = useSession((s) => s.user);
  const refreshUser = useSession((s) => s.refreshUser);
  const enabled = !!user?.totpEnabled;
  const pkSupported = browserSupportsWebAuthn();

  const [tab, setTab] = useState<PanelTab>('signin');
  const [enroll, setEnroll] = useState<Enroll | null>(null);
  const [step, setStep] = useState<Step>(1);
  const [savedCodes, setSavedCodes] = useState(false);
  const [code, setCode] = useState('');
  const [disabling, setDisabling] = useState(false);
  const [disableCode, setDisableCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [passkeys, setPasskeys] = useState<PasskeyInfo[]>([]);
  const [pkName, setPkName] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);

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
  const removePasskey = async (id: string, nickname: string) => {
    const last = passkeys.length === 1;
    const ok = await askConfirm({
      title: `Remove “${nickname}”?`,
      body: (
        <p>
          That device can no longer sign you in.
          {last ? ' It’s your only passkey — you’ll be back to password sign-in until you add another.' : ''}
        </p>
      ),
      confirmLabel: 'Remove passkey',
    });
    if (!ok) return;
    await run(async () => { await auth.passkey.remove(id); await loadPasskeys(); });
  };
  const saveRename = () => {
    if (!renaming) return;
    const name = renaming.value.trim();
    const { id } = renaming;
    setRenaming(null);
    if (name) void run(async () => { await auth.passkey.rename(id, name); await loadPasskeys(); });
  };

  const startEnroll = () =>
    run(async () => {
      const r = await auth.totpEnroll();
      setEnroll({ qr: r.qr, otpauthUrl: r.otpauthUrl, secret: r.secret, backupCodes: r.backupCodes });
      setStep(1);
      setSavedCodes(false);
      setCode('');
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
      await auth.totpDisable(disableCode.trim());
      await refreshUser();
      setDisableCode('');
      setDisabling(false);
      setNotice('Two-factor authentication is off.');
    });

  const copy = (text: string, done: string) => {
    void navigator.clipboard?.writeText(text);
    setNotice(done);
  };

  const passkeyBadge = <span className={`pill ${passkeys.length ? 'pill-success' : ''}`}>{passkeys.length ? `${passkeys.length} set up` : 'None yet'}</span>;
  const totpBadge = <span className={`pill ${enabled ? 'pill-success' : ''}`}>{enabled ? 'On' : 'Off'}</span>;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal security-modal" role="dialog" aria-modal="true" aria-label="Security" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Security</h2>
          <button className="icon-btn" onClick={onClose} aria-label="close">✕</button>
        </header>

        <Tabs
          label="Security section"
          options={[{ value: 'signin', label: 'Sign-in' }, { value: 'tokens', label: 'Access tokens' }]}
          value={tab}
          onChange={setTab}
        />

        <div className="security-body">
          {notice && <Notice tone="success">{notice}</Notice>}
          {error && <Notice>{error}</Notice>}

          {tab === 'tokens' && <PersonalTokens />}

          {tab === 'signin' && (
            <>
              <Section title="Passkeys" badge={passkeyBadge} description="Sign in with Face ID, a fingerprint or a security key — no password to type.">
                <ul className="passkey-list">
                  {passkeys.map((p) => (
                    <li key={p.id} className="passkey-item">
                      {renaming?.id === p.id ? (
                        <form className="passkey-rename" onSubmit={(e) => { e.preventDefault(); saveRename(); }}>
                          <input
                            value={renaming.value}
                            onChange={(e) => setRenaming({ id: p.id, value: e.target.value })}
                            onKeyDown={(e) => { if (e.key === 'Escape') setRenaming(null); }}
                            aria-label="Passkey name"
                            maxLength={60}
                            autoFocus
                          />
                          <button type="submit" className="btn tiny primary" disabled={busy || !renaming.value.trim()}>Save</button>
                          <button type="button" className="btn tiny ghost" onClick={() => setRenaming(null)}>Cancel</button>
                        </form>
                      ) : (
                        <>
                          <div className="passkey-main">
                            <span className="passkey-name">{p.nickname}</span>
                            <span className="passkey-meta">added {timeAgo(p.createdAt)}{p.lastUsedAt ? ` · used ${timeAgo(p.lastUsedAt)}` : ' · never used'}</span>
                          </div>
                          <button className="row-action" disabled={busy} onClick={() => setRenaming({ id: p.id, value: p.nickname })}>Rename</button>
                          <button className="row-action danger" disabled={busy} onClick={() => void removePasskey(p.id, p.nickname)}>Remove</button>
                        </>
                      )}
                    </li>
                  ))}
                  {!passkeys.length && <EmptyState as="li">No passkeys yet.</EmptyState>}
                </ul>
                {pkSupported ? (
                  <div className="passkey-add">
                    <input value={pkName} onChange={(e) => setPkName(e.target.value)} placeholder="Name it (optional), e.g. iPhone" aria-label="New passkey name" maxLength={60} />
                    <button className="btn primary" disabled={busy} onClick={addPasskey}>Add a passkey</button>
                  </div>
                ) : (
                  <p className="section-desc">This browser doesn’t support passkeys.</p>
                )}
              </Section>

              <Section title="Two-factor authentication" badge={totpBadge} description="A 6-digit code from an authenticator app, asked for after your password.">
                {!enabled && !enroll && (
                  <button className="btn primary security-act" disabled={busy} onClick={startEnroll}>Set up two-factor</button>
                )}

                {!enabled && enroll && (
                  <div className="security-enroll">
                    <ol className="steps" aria-label="Setup progress">
                      {STEP_LABELS.map((label, i) => (
                        <li key={label} className={step === i + 1 ? 'is-current' : step > i + 1 ? 'is-done' : ''} aria-current={step === i + 1 ? 'step' : undefined}>
                          <span className="steps-num">{i + 1}</span>{label}
                        </li>
                      ))}
                    </ol>

                    {step === 1 && (
                      <>
                        <p className="section-desc">Scan this with an authenticator app. On this device, add it directly instead.</p>
                        <img className="security-qr" src={enroll.qr} alt="TOTP QR code" />
                        <a className="btn ghost security-act" href={enroll.otpauthUrl}>Add to authenticator app</a>
                        <p className="section-desc">
                          Or enter this key by hand: <code>{enroll.secret}</code>{' '}
                          <button type="button" className="link-btn" onClick={() => copy(enroll.secret, 'Key copied.')}>copy</button>
                        </p>
                      </>
                    )}

                    {step === 2 && (
                      <>
                        <p className="section-desc"><strong>Save these backup codes now.</strong> Each works once, and they’re how you get in if you lose your phone. They won’t be shown again.</p>
                        <ul className="backup-codes">
                          {enroll.backupCodes.map((c) => <li key={c}><code>{c}</code></li>)}
                        </ul>
                        <div className="security-actions">
                          <button type="button" className="btn ghost tiny" onClick={() => copy(enroll.backupCodes.join('\n'), 'Backup codes copied.')}>Copy</button>
                          <button type="button" className="btn ghost tiny" onClick={() => downloadCodes(enroll.backupCodes)}>Download</button>
                        </div>
                        <label className="check-row">
                          <input type="checkbox" checked={savedCodes} onChange={(e) => setSavedCodes(e.target.checked)} />
                          I’ve saved these codes somewhere safe
                        </label>
                      </>
                    )}

                    {step === 3 && (
                      <label className="field">
                        <span>code from your app</span>
                        <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" autoFocus />
                      </label>
                    )}

                    <div className="security-actions">
                      {step > 1 && <button type="button" className="btn ghost" disabled={busy} onClick={() => setStep((s) => (s - 1) as Step)}>Back</button>}
                      <button type="button" className="btn ghost" disabled={busy} onClick={() => setEnroll(null)}>Cancel</button>
                      {step === 1 && <button type="button" className="btn primary" onClick={() => setStep(2)}>Next</button>}
                      {step === 2 && <button type="button" className="btn primary" disabled={!savedCodes} onClick={() => setStep(3)}>Next</button>}
                      {step === 3 && <button type="button" className="btn primary" disabled={busy || !code.trim()} onClick={confirmEnroll}>Turn on</button>}
                    </div>
                  </div>
                )}

                {enabled && !disabling && (
                  <button className="btn ghost security-act" disabled={busy} onClick={() => setDisabling(true)}>Turn off two-factor…</button>
                )}
                {enabled && disabling && (
                  <div className="security-danger">
                    <label className="field">
                      <span>current or backup code</span>
                      <input value={disableCode} onChange={(e) => setDisableCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" autoFocus />
                    </label>
                    <div className="security-actions">
                      <button className="btn ghost" disabled={busy} onClick={() => { setDisabling(false); setDisableCode(''); }}>Cancel</button>
                      <button className="btn danger" disabled={busy || !disableCode.trim()} onClick={disable}>Turn off</button>
                    </div>
                  </div>
                )}
              </Section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
