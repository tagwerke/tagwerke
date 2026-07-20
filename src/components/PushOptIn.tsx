// Web-push opt-in control (NOTIFICATIONS.md, Phase 4). Lets a user enable device/desktop push
// on THIS browser. Renders nothing when push can't work (no SW/PushManager support, or the
// server has no VAPID keys configured → GET vapid-key returns null).
//
// IMPORTANT: "on" is NOT `Notification.permission === 'granted'`. Permission can be granted while
// the actual PushManager subscription has been wiped (cleared site data, re-registered SW, browser
// eviction) — leaving the SERVER with zero subscriptions and nothing to send. So we reconcile: on
// open, if permission is granted we make sure a real subscription exists AND is (re)registered with
// the server. This self-heals a missing subscription just by opening the panel.
//
// Note: the service worker only registers in a production build (src/main.tsx gates on PROD), so
// this control is a no-op in `npm run dev` — test push against a built/preview server.

import { useEffect, useState } from 'react';
import { api } from '../api/client';

type State = 'unsupported' | 'loading' | 'default' | 'granted' | 'denied' | 'busy';

/** Convert a base64url VAPID key to the ArrayBuffer the PushManager expects (applicationServerKey
 *  wants a BufferSource; an explicit ArrayBuffer satisfies the strict DOM types). */
function urlBase64ToBuffer(base64: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const buffer = new ArrayBuffer(raw.length);
  const arr = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return buffer;
}

const pushSupported = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/** Get the active SW registration, but never hang if none is registered (dev has no SW). */
async function readyRegistration(): Promise<ServiceWorkerRegistration | null> {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
  ]);
}

/** Ensure a real push subscription exists for this browser AND is registered with the server.
 *  Reuses an existing subscription or creates one; always re-POSTs it (idempotent server-side) so a
 *  server that lost the row gets it back. Returns true when the server now has our subscription. */
async function ensureSubscribed(vapidKey: string): Promise<boolean> {
  const reg = await readyRegistration();
  if (!reg) return false; // no active SW (dev build) — can't subscribe
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToBuffer(vapidKey),
    });
  }
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return false;
  await api.notifications.subscribePush({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } });
  return true;
}

export function PushOptIn() {
  const [vapidKey, setVapidKey] = useState<string | null>(null);
  const [state, setState] = useState<State>('loading');

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!pushSupported) {
        if (alive) setState('unsupported');
        return;
      }
      let key: string | null;
      try {
        key = (await api.notifications.vapidKey()).key;
      } catch {
        if (alive) setState('unsupported');
        return;
      }
      if (!alive) return;
      if (!key) {
        setState('unsupported'); // server has no VAPID keys → push disabled instance-wide
        return;
      }
      setVapidKey(key);
      if (Notification.permission === 'denied') {
        setState('denied');
        return;
      }
      if (Notification.permission === 'granted') {
        // Permission already granted — but the subscription may be missing on the server (cleared
        // site data / re-registered SW). Reconcile silently; only claim "on" if the server has it.
        try {
          const ok = await ensureSubscribed(key);
          if (alive) setState(ok ? 'granted' : 'default');
        } catch {
          if (alive) setState('default'); // couldn't reconcile — offer the button to retry
        }
        return;
      }
      setState('default'); // permission not yet requested
    })();
    return () => {
      alive = false;
    };
  }, []);

  const enable = async () => {
    if (!vapidKey) return;
    setState('busy');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'denied' : 'default');
        return;
      }
      const ok = await ensureSubscribed(vapidKey);
      setState(ok ? 'granted' : 'default');
    } catch {
      setState('default'); // prompt dismissed / SW not ready (dev) — leave it offerable
    }
  };

  if (state === 'unsupported' || state === 'loading') return null;

  if (state === 'granted') {
    return (
      <div className="notif-push notif-push-on">
        <span>Push is on for this device.</span>
        <button className="link-btn" onClick={() => void api.notifications.testPush()}>Send test push</button>
      </div>
    );
  }
  if (state === 'denied') {
    return <div className="notif-push">Push is blocked in your browser settings for this site.</div>;
  }
  return (
    <button className="btn ghost notif-push-btn" disabled={state === 'busy'} onClick={() => void enable()}>
      {state === 'busy' ? 'Enabling…' : 'Enable push on this device'}
    </button>
  );
}
