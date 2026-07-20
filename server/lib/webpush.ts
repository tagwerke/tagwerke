// Web-push delivery (NOTIFICATIONS.md, Phase 4). The device-delivery half of the notify()
// spine: given a recipient, encrypt+send a payload to every browser/device they've opted in
// from (rows in `push_subscriptions`). Called by notify() ONLY when the presence gate says the
// user is offline (no live socket), so an in-app-connected user never gets a redundant push.
//
// Entirely env-guarded: with no VAPID_* keys configured, isPushConfigured() is false and every
// send is a no-op — in-app notifications keep working, only device push is disabled. A dead
// endpoint (the browser unsubscribed / the push service 404/410s) is deleted on send so the
// table self-cleans. Fire-and-forget, like recordAudit/notify: never throws into the caller.

import webpush from 'web-push';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { dlog, sid } from './dlog.ts';

const PUBLIC = process.env.VAPID_PUBLIC_KEY;
const PRIVATE = process.env.VAPID_PRIVATE_KEY;
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

const configured = !!(PUBLIC && PRIVATE);
if (configured) {
  webpush.setVapidDetails(SUBJECT, PUBLIC!, PRIVATE!);
}

/** True when VAPID keys are set — device push is possible. The client also gates its opt-in UI
 *  on this (via GET /api/notifications/vapid-key returning null when unconfigured). */
export function isPushConfigured(): boolean {
  return configured;
}

/** The public VAPID key the browser needs to create a subscription, or null if push is off. */
export function vapidPublicKey(): string | null {
  return configured ? PUBLIC! : null;
}

/** The payload the service worker's `push` handler expects (see public/sw.js). */
export interface PushPayload {
  title: string;
  body?: string | null;
  tabId?: string | null;
  notifId?: string;
}

/** Send a push to every device `userId` has registered. No-op if push is unconfigured or the
 *  user has no subscriptions. Best-effort per endpoint; prunes endpoints the push service rejects. */
export async function pushToUser(userId: string, payload: PushPayload): Promise<void> {
  if (!configured) {
    dlog('push', `pushToUser user=${sid(userId)} SKIP — VAPID not configured`);
    return;
  }
  let subs: { endpoint: string; p256dh: string; auth: string }[];
  try {
    subs = await db
      .select({ endpoint: schema.pushSubscriptions.endpoint, p256dh: schema.pushSubscriptions.p256dh, auth: schema.pushSubscriptions.auth })
      .from(schema.pushSubscriptions)
      .where(eq(schema.pushSubscriptions.userId, userId));
  } catch (err) {
    dlog('push', `pushToUser user=${sid(userId)} subscription lookup FAILED`, err);
    return; // best-effort: a DB hiccup must not break the request that triggered the notify
  }
  dlog('push', `pushToUser user=${sid(userId)} subscriptions=${subs.length}`);
  if (!subs.length) return;
  const data = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, data);
        dlog('push', `pushToUser user=${sid(userId)} sent OK endpoint=…${s.endpoint.slice(-12)}`);
      } catch (err: unknown) {
        // 404/410 = the subscription is gone (browser cleared it / expired). Prune it so we
        // stop trying. Any other error (transient network/5xx) is left for the next send.
        const status = (err as { statusCode?: number })?.statusCode;
        const body = (err as { body?: string })?.body;
        dlog('push', `pushToUser user=${sid(userId)} send FAILED status=${status ?? '?'} endpoint=…${s.endpoint.slice(-12)} body=${body ?? (err as Error)?.message ?? ''}`);
        if (status === 404 || status === 410) {
          await db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.endpoint, s.endpoint)).catch(() => {});
        }
      }
    }),
  );
}
