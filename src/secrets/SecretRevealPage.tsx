// The recipient's page for a one-time secret link: /s/:id#<key>.
//
// Rendered straight from main.tsx, OUTSIDE <App/> — no session check, no store hydrate, no realtime
// socket, no service-worker-dependent state. The recipient is usually not a Tagwerke user, and even
// when they are, nothing on this page should touch their session.
//
// Three rules from the plan, all load-bearing:
//   • Opening the page does NOT burn the link (D2). Slack, Outlook and mail scanners fetch links; only
//     the Reveal button's POST burns it.
//   • The key is read from the fragment once, then the fragment is wiped from the address bar, so it
//     does not linger in history or get copied onward with the URL.
//   • The secret is not in the DOM until the person asks for it.

import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { decryptFromLink, isLinkKey, linkCryptoAvailable } from './linkCrypto';

type Phase =
  | { kind: 'ready' }
  | { kind: 'busy' }
  | { kind: 'shown'; text: string }
  | { kind: 'gone' }
  | { kind: 'broken'; reason: string };

export function SecretRevealPage({ id }: { id: string }) {
  // Captured on the first render, before the effect below strips it from the URL.
  const [key, setKey] = useState(() => window.location.hash.slice(1));
  const [phase, setPhase] = useState<Phase>(() => {
    if (!linkCryptoAvailable()) return { kind: 'broken', reason: 'This page has to be opened over HTTPS to decrypt a secret.' };
    if (!isLinkKey(window.location.hash.slice(1))) {
      return { kind: 'broken', reason: 'This link is incomplete — the part after “#” is missing or cut off. Ask the sender to copy the whole link again. Nothing has been opened yet.' };
    }
    return { kind: 'ready' };
  });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    document.title = 'A secret for you · Tagwerke';
    const robots = document.createElement('meta');
    robots.name = 'robots';
    robots.content = 'noindex, nofollow';
    document.head.appendChild(robots);
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
    return () => robots.remove();
  }, []);

  async function reveal(): Promise<void> {
    setPhase({ kind: 'busy' });
    let ciphertext: string;
    try {
      ciphertext = (await api.secretLinks.reveal(id)).ciphertext;
    } catch {
      setPhase({ kind: 'gone' });
      return;
    }
    try {
      setPhase({ kind: 'shown', text: await decryptFromLink(ciphertext, key) });
    } catch {
      setPhase({ kind: 'broken', reason: 'The link was opened, but its key does not match — it was probably altered on the way. The secret cannot be recovered; ask the sender for a new link.' });
    } finally {
      setKey('');
    }
  }

  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      /* the text is selectable; copying by hand still works */
    }
  }

  return (
    <div className="secret-reveal">
      <div className="secret-reveal-card">
        <p className="secret-reveal-brand">Tagwerke</p>
        {phase.kind === 'ready' || phase.kind === 'busy' ? (
          <>
            <h1>Someone shared a secret with you</h1>
            <p>It can be viewed <strong>once</strong>. After you reveal it, it is deleted from the server and this link stops working.</p>
            <p className="secret-reveal-hint">Have somewhere safe ready to put it, like a password manager.</p>
            <button className="btn primary" disabled={phase.kind === 'busy'} onClick={() => void reveal()}>
              {phase.kind === 'busy' ? 'Opening…' : 'Reveal secret'}
            </button>
          </>
        ) : phase.kind === 'shown' ? (
          <>
            <h1>Here it is</h1>
            <textarea className="secret-reveal-text" readOnly value={phase.text} rows={Math.min(10, phase.text.split('\n').length + 1)} onFocus={(e) => e.currentTarget.select()} />
            <div className="secret-reveal-actions">
              <button className="btn primary" onClick={() => void copy(phase.text)}>{copied ? 'Copied' : 'Copy'}</button>
            </div>
            <p className="secret-reveal-hint">It has been deleted from the server. Save it now: reloading or closing this page loses it for good.</p>
          </>
        ) : phase.kind === 'gone' ? (
          <>
            <h1>This link is no longer available</h1>
            <p>It may have been opened already, expired, or been revoked by the sender. If you did not open it yourself, tell the sender. Someone else may have.</p>
          </>
        ) : (
          <>
            <h1>This link can’t be opened</h1>
            <p>{phase.reason}</p>
          </>
        )}
      </div>
    </div>
  );
}
