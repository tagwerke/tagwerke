import { useCallback, useEffect, useState } from 'react';
import { getSidecarHealth, triggerSync, type SyncResult } from '../util/storage';

type Status = 'idle' | 'syncing' | 'ok' | 'error';

function fmtAgo(ms: number | null): string {
  if (!ms) return 'never';
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

function describe(r: SyncResult): string {
  switch (r.direction) {
    case 'push': return 'pushed to peer';
    case 'pull': return 'pulled from peer';
    case 'in-sync': return 'already in sync';
    case 'noop': return r.reason ?? 'nothing to do';
  }
}

export function SyncButton() {
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState<string>('');
  const [lastModified, setLastModified] = useState<number | null>(null);
  const [peerConfigured, setPeerConfigured] = useState(true);

  const refreshHealth = useCallback(async () => {
    try {
      const h = await getSidecarHealth();
      setLastModified(h.lastModified);
      setPeerConfigured(h.peerUrl != null);
    } catch {
      /* surfaces during sync attempt; no need to nag */
    }
  }, []);

  useEffect(() => { void refreshHealth(); }, [refreshHealth]);

  const onSync = async () => {
    setStatus('syncing');
    setMessage('');
    try {
      const r = await triggerSync();
      setStatus('ok');
      setMessage(describe(r));
      await refreshHealth();
    } catch (e) {
      setStatus('error');
      setMessage(e instanceof Error ? e.message : 'sync failed');
    }
  };

  const title = peerConfigured
    ? `Last write: ${fmtAgo(lastModified)}${message ? ` · ${message}` : ''}`
    : 'No peerUrl in ~/.do-app/config.json';

  return (
    <button
      className={`btn ghost sync ${status}`}
      onClick={onSync}
      disabled={status === 'syncing' || !peerConfigured}
      title={title}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
        <path
          d="M3 8a5 5 0 0 1 8.5-3.5L13 6M13 8a5 5 0 0 1-8.5 3.5L3 10M13 3v3h-3M3 13v-3h3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span>
        {status === 'syncing' ? 'syncing…' : status === 'error' ? 'sync ✗' : 'sync'}
      </span>
    </button>
  );
}
