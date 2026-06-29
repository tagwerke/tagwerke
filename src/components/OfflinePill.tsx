import { useOffline } from '../offline/status';

// Compact connectivity indicator. Silent when online and fully synced; shows
// "offline" (with any queued-write count) or a live "syncing…" otherwise.
export function OfflinePill() {
  const online = useOffline((s) => s.online);
  const pending = useOffline((s) => s.pending);
  const syncing = useOffline((s) => s.syncing);

  if (online && pending === 0) return null;

  const offline = !online;
  const label = offline
    ? (pending > 0 ? `offline · ${pending}` : 'offline')
    : (syncing ? 'syncing…' : `queued · ${pending}`);

  return (
    <span className={`net-pill ${offline ? 'is-offline' : 'is-syncing'}`} title={
      offline
        ? `You're offline${pending ? ` — ${pending} change${pending === 1 ? '' : 's'} will sync when you reconnect` : ''}`
        : `${pending} change${pending === 1 ? '' : 's'} syncing`
    }>
      <span className="net-dot" />
      {label}
    </span>
  );
}
