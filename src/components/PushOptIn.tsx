// Web-push opt-in control (NOTIFICATIONS.md, Phase 4). Lets a user enable device/desktop push
// on THIS browser. Renders nothing when push can't work (no SW/PushManager support, or the
// server has no VAPID keys configured → GET vapid-key returns null). Enabling: ask permission →
// create a PushManager subscription against the server's VAPID public key → register it server-side.
//
// Note: the service worker only registers in a production build (src/main.tsx gates on PROD), so
// this control is effectively a no-op in `npm run dev` — test push against a built/preview server.

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
      try {
        const { key } = await api.notifications.vapidKey();
        if (!alive) return;
        if (!key) {
          setState('unsupported'); // server has no VAPID keys → push disabled instance-wide
          return;
        }
        setVapidKey(key);
        setState(Notification.permission === 'granted' ? 'granted' : Notification.permission === 'denied' ? 'denied' : 'default');
      } catch {
        if (alive) setState('unsupported');
      }
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
      // serviceWorker.ready never resolves when no SW is registered (e.g. `npm run dev`, where
      // registration is PROD-only) — race it against a timeout so the button can't hang.
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      if (!reg) {
        setState('default'); // no active SW (dev build) — leave the offer in place
        return;
      }
      const existing = await reg.pushManager.getSubscription();
      const sub =
        existing ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToBuffer(vapidKey),
        }));
      const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
      if (json.endpoint && json.keys?.p256dh && json.keys?.auth) {
        await api.notifications.subscribePush({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } });
      }
      setState('granted');
    } catch {
      setState('default'); // permission prompt dismissed / SW not ready (dev) — leave it offerable
    }
  };

  if (state === 'unsupported' || state === 'loading') return null;

  if (state === 'granted') {
    return <div className="notif-push notif-push-on">Push is on for this device.</div>;
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
