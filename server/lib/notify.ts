// The notification spine (NOTIFICATIONS.md). ONE function every event calls. It:
//   1. inserts a row into `notifications`               → the in-app bell/feed + read state
//   2. publishes it live over the user's realtime channel → instant in-app toast if connected
//   3. PRESENCE GATE — if the user has no live socket, pushes it to their devices instead
//
// The presence gate is the whole routing brain, and it's free: subscriberCount(userChannel(id))
// is >0 exactly when the user has an open realtime connection (ws.ts subscribes the user channel
// once per connection). Connected → they'll see the live frame, skip the push. Away → push.
//
// Fire-and-forget by design, exactly like recordAudit: a failed notify must NEVER break or delay
// the request that triggered it. Self-notifications are the caller's concern (skip when actor ===
// recipient) — this module just delivers what it's handed.

import { nanoid } from 'nanoid';
import { db, schema } from '../db/client.ts';
import { publish, userChannel, subscriberCount } from './bus.ts';
import { pushToUser } from './webpush.ts';
import { dlog, sid } from './dlog.ts';

const PROTOCOL_VERSION = 1;

export type NotificationType = 'task_assigned' | 'review_requested' | 'task_approved' | 'board_added';

export interface NotifyInput {
  type: NotificationType;
  title: string;
  body?: string | null;
  tabId?: string | null; // board to open on click
  actorId?: string | null; // who caused it
}

/** Deliver one notification to one user: persist → live push → (offline) device push. */
export function notify(userId: string, input: NotifyInput): void {
  const row = {
    id: nanoid(),
    userId,
    type: input.type,
    title: input.title,
    body: input.body ?? null,
    tabId: input.tabId ?? null,
    actorId: input.actorId ?? null,
    readAt: null as Date | null,
    createdAt: new Date(),
  };
  void (async () => {
    try {
      await db.insert(schema.notifications).values(row);
    } catch {
      return; // couldn't persist → nothing to deliver
    }
    // Live in-app frame (the client prepends it to the feed + bumps the unread badge). The row's
    // createdAt is serialized to an ISO string so the wire shape matches GET /api/notifications.
    publish(userChannel(userId), {
      v: PROTOCOL_VERSION,
      type: 'notification',
      notification: { ...row, createdAt: row.createdAt.toISOString(), readAt: null },
    });
    // Device push is ALWAYS sent (presence gating removed by request): a connected or backgrounded
    // app still gets a device notification, not just the live in-app frame. subscriberCount is
    // logged for visibility only — it no longer suppresses anything.
    const live = subscriberCount(userChannel(userId));
    dlog('push', `notify user=${sid(userId)} type=${row.type} liveSockets=${live} → PUSH (gate off)`);
    await pushToUser(userId, { title: row.title, body: row.body, tabId: row.tabId, notifId: row.id }).catch((err) => {
      dlog('push', `notify user=${sid(userId)} pushToUser threw`, err);
    });
  })();
}
