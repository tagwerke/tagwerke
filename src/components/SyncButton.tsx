import { useCallback, useEffect, useRef, useState } from 'react';
import { getSidecarHealth, triggerSync, type SyncResult } from '../util/storage';

type Direction = SyncResult['direction'];
type Status = 'idle' | 'syncing' | Direction | 'error';

function fmtAgo(ms: number | null): string {
  if (!ms) return 'never';
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

function label(status: Status): string {
  switch (status) {
    case 'idle': return 'sync';
    case 'syncing': return 'syncing…';
    case 'push': return 'pushed';
    case 'pull': return 'pulled';
    case 'in-sync': return 'in sync';
    case 'noop': return 'no state';
    case 'error': return 'sync';
  }
}

function friendlyError(raw: string): { short: string; detail: string } {
  const detail = raw;
  if (/no peerUrl/i.test(raw)) return { short: 'no peer set', detail };
  if (/peer unreachable|peer GET timed out|peer PUT/i.test(raw)) return { short: 'peer offline', detail };
  if (/Failed to fetch|NetworkError|ECONNREFUSED/i.test(raw)) return { short: 'sidecar down', detail };
  if (/push failed/i.test(raw)) return { short: 'push failed', detail };
  if (/sidecar \/health|sidecar GET|sidecar PUT/i.test(raw)) return { short: 'sidecar error', detail };
  return { short: 'error', detail };
}

function Icon({ status }: { status: Status }) {
  const common = { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (status) {
    case 'push':
      return (
        <svg {...common}><path d="M8 13V3M8 3l-3 3M8 3l3 3" /></svg>
      );
    case 'pull':
      return (
        <svg {...common}><path d="M8 3v10M8 13l-3-3M8 13l3-3" /></svg>
      );
    case 'in-sync':
      return (
        <svg {...common}><path d="M3.5 8.5l3 3 6-6" /></svg>
      );
    case 'noop':
      return (
        <svg {...common}><path d="M4 8h8" /></svg>
      );
    case 'error':
      return (
        <svg {...common}><path d="M8 2.5l6.5 11h-13L8 2.5z M8 6.5v3.5 M8 12v.5" /></svg>
      );
    case 'syncing':
    case 'idle':
    default:
      return (
        <svg {...common}><path d="M3 8a5 5 0 0 1 8.5-3.5L13 6M13 8a5 5 0 0 1-8.5 3.5L3 10M13 3v3h-3M3 13v-3h3" /></svg>
      );
  }
}

const RESULT_TTL_MS = 4000;

export function SyncButton() {
  const [status, setStatus] = useState<Status>('idle');
  const [errorShort, setErrorShort] = useState<string>('');
  const [errorDetail, setErrorDetail] = useState<string>('');
  const [lastModified, setLastModified] = useState<number | null>(null);
  const [peerUrl, setPeerUrl] = useState<string | null>(null);
  const [peerConfigured, setPeerConfigured] = useState(true);
  const revertTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshHealth = useCallback(async () => {
    try {
      const h = await getSidecarHealth();
      setLastModified(h.lastModified);
      setPeerUrl(h.peerUrl);
      setPeerConfigured(h.peerUrl != null);
    } catch {
      /* surfaces during sync attempt; no need to nag */
    }
  }, []);

  useEffect(() => { void refreshHealth(); }, [refreshHealth]);

  useEffect(() => () => { if (revertTimer.current) clearTimeout(revertTimer.current); }, []);

  const scheduleRevert = () => {
    if (revertTimer.current) clearTimeout(revertTimer.current);
    revertTimer.current = setTimeout(() => setStatus('idle'), RESULT_TTL_MS);
  };

  const onSync = async () => {
    if (revertTimer.current) { clearTimeout(revertTimer.current); revertTimer.current = null; }
    setStatus('syncing');
    setErrorShort('');
    setErrorDetail('');
    try {
      const r = await triggerSync();
      setStatus(r.direction);
      await refreshHealth();
      scheduleRevert();
    } catch (e) {
      const raw = e instanceof Error ? e.message : 'sync failed';
      const { short, detail } = friendlyError(raw);
      setStatus('error');
      setErrorShort(short);
      setErrorDetail(detail);
    }
  };

  let title: string;
  if (!peerConfigured) {
    title = 'No peerUrl in ~/.do-app/config.json';
  } else if (status === 'error') {
    title = `${errorShort}: ${errorDetail}\nPeer: ${peerUrl ?? '—'}`;
  } else {
    const verb =
      status === 'push' ? 'just pushed to peer' :
      status === 'pull' ? 'just pulled from peer' :
      status === 'in-sync' ? 'already in sync with peer' :
      status === 'noop' ? 'neither side has state yet' :
      status === 'syncing' ? 'syncing…' :
      `last write: ${fmtAgo(lastModified)}`;
    title = `${verb}\nPeer: ${peerUrl ?? '—'}`;
  }

  const displayLabel = status === 'error' ? (errorShort || 'error') : label(status);
  const stateClass = status === 'push' || status === 'pull' || status === 'in-sync' || status === 'noop' ? 'ok' : status;

  return (
    <button
      className={`btn ghost sync ${stateClass} state-${status}`}
      onClick={onSync}
      disabled={status === 'syncing' || !peerConfigured}
      title={title}
    >
      <Icon status={status} />
      <span>{displayLabel}</span>
    </button>
  );
}
