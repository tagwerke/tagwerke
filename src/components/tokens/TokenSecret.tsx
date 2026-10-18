// A freshly created token's secret. Shown exactly once — the server keeps only a hash — so this
// says so, offers a copy button, and gives the env line an agent would use.

import { useState } from 'react';

export function TokenSecret({ token, onDone }: { token: string; onDone: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const envLine = `TAGWERKE_TOKEN=${token}`;

  async function copy(key: string, text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      /* clipboard blocked: the text is selectable below */
    }
  }

  return (
    <div className="token-secret" role="status">
      <strong>Copy this token now.</strong> It won’t be shown again — if you lose it, create a new one.
      <code className="token-secret-value">{token}</code>
      <div className="token-secret-actions">
        <button type="button" className="btn primary" onClick={() => void copy('token', token)}>{copied === 'token' ? 'Copied' : 'Copy token'}</button>
        <button type="button" className="btn ghost" onClick={() => void copy('env', envLine)}>{copied === 'env' ? 'Copied' : 'Copy as env line'}</button>
        <span className="secret-spacer" />
        <button type="button" className="btn ghost" onClick={onDone}>Done</button>
      </div>
    </div>
  );
}
