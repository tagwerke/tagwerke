// Notification feed routes (NOTIFICATIONS.md). Everything here is scoped to the CURRENT user
// (req.user.id) — a notification belongs to exactly one recipient, so there's no board-role
// check, just requireAuth. Rows are emitted elsewhere (server/lib/notify.ts); these routes only
// read the feed, flip read state, and manage this user's push subscriptions.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { requireAuth } from '../auth/guard.ts';
import { vapidPublicKey, pushToUser } from '../lib/webpush.ts';
import { dlog, sid } from '../lib/dlog.ts';
import { encodeCursor, newerThan, nextCursor, olderThan, pageLimit } from '../lib/cursor.ts';

const subscribeBody = z.object({
  endpoint: z.string().min(1),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  // These are per-user reads / own-state writes — keep them out of the audit trail.
  app.addHook('preHandler', async (req) => {
    req.auditHandled = true;
  });

  // One page of this user's feed, newest first (`?cursor=` for older ones) + the current unread
  // count (for the bell badge).
  //
  // `?after=<cursor>` flips it for a client catching up (AGENT_COMMENTS_PLAN.md): rows NEWER than the
  // cursor, oldest first, `more` saying whether to call again with `after=latest`. `latest` is the
  // cursor to save: the newest row returned, or the one passed in when nothing is new.
  //
  // This is the one notifications route a personal access token may call (read only: marking read
  // stays the human's). A token sees only rows for boards it reaches that the owner is still on.
  app.get(
    '/api/notifications',
    { config: { pat: 'read', rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req) => {
      const userId = req.user!.id;
      const q = req.query as { cursor?: string; after?: string; limit?: string };
      const catchUp = q.after !== undefined;
      const limit = catchUp ? pageLimit(q.limit, 100, 100) : pageLimit(q.limit, 50, 200);
      const n = schema.notifications;

      const mine = and(
        eq(n.userId, userId),
        req.pat && isNotNull(n.tabId),
        req.pat && !req.pat.allBoards ? (req.pat.tabIds.size ? inArray(n.tabId, [...req.pat.tabIds]) : sql`false`) : undefined,
        req.pat
          ? inArray(n.tabId, db.select({ id: schema.boardMembers.tabId }).from(schema.boardMembers).where(eq(schema.boardMembers.userId, userId)))
          : undefined,
      );

      const rows = await db
        .select()
        .from(n)
        .where(and(
          mine,
          catchUp
            ? newerThan(q.after!, n.createdAt, n.id)
            : q.cursor ? olderThan(q.cursor, n.createdAt, n.id) : undefined,
        ))
        .orderBy(...(catchUp ? [asc(n.createdAt), asc(n.id)] : [desc(n.createdAt), desc(n.id)]))
        .limit(limit);
      const unread = (
        await db
          .select({ n: sql<number>`count(*)::int` })
          .from(n)
          .where(and(mine, isNull(n.readAt)))
      )[0]?.n ?? 0;

      const newest = catchUp ? rows[rows.length - 1] : rows[0];
      return {
        notifications: rows.map((r) => ({
          ...r,
          createdAt: r.createdAt.toISOString(),
          readAt: r.readAt?.toISOString() ?? null,
        })),
        unread,
        ...(catchUp
          ? { latest: newest ? encodeCursor(newest.createdAt, newest.id) : q.after!, more: rows.length === limit }
          : {
              latest: newest ? encodeCursor(newest.createdAt, newest.id) : null,
              nextCursor: nextCursor(rows, limit, (r) => ({ at: r.createdAt, id: r.id })),
            }),
      };
    },
  );

  // Mark one notification read (idempotent; scoped to the owner so you can't touch others').
  app.post('/api/notifications/:id/read', async (req, reply) => {
    const { id } = req.params as { id: string };
    await db
      .update(schema.notifications)
      .set({ readAt: new Date() })
      .where(and(eq(schema.notifications.id, id), eq(schema.notifications.userId, req.user!.id), isNull(schema.notifications.readAt)));
    return reply.send({ ok: true });
  });

  // Mark all of this user's unread notifications read.
  app.post('/api/notifications/read-all', async (req, reply) => {
    await db
      .update(schema.notifications)
      .set({ readAt: new Date() })
      .where(and(eq(schema.notifications.userId, req.user!.id), isNull(schema.notifications.readAt)));
    return reply.send({ ok: true });
  });

  // Clear (delete) this user's entire feed. Scoped to the owner, so it only ever touches your own
  // rows. Hard delete — the feed is a transient convenience surface, not the audit trail.
  app.delete('/api/notifications', async (req, reply) => {
    await db.delete(schema.notifications).where(eq(schema.notifications.userId, req.user!.id));
    return reply.send({ ok: true });
  });

  // The browser needs the public VAPID key to build a push subscription. null = push disabled
  // (no keys configured) → the client hides the "enable push" affordance.
  app.get('/api/notifications/vapid-key', async () => {
    return { key: vapidPublicKey() };
  });

  // Register (or refresh) a device push subscription for this user. Upsert on the unique endpoint
  // so re-subscribing the same browser is idempotent and re-points it at the current user.
  app.post('/api/notifications/subscribe', async (req, reply) => {
    const b = subscribeBody.safeParse(req.body);
    if (!b.success) {
      dlog('push', `subscribe user=${sid(req.user!.id)} REJECTED — invalid body`);
      return reply.code(400).send({ error: 'invalid subscription' });
    }
    await db
      .insert(schema.pushSubscriptions)
      .values({ id: nanoid(), userId: req.user!.id, endpoint: b.data.endpoint, p256dh: b.data.keys.p256dh, auth: b.data.keys.auth })
      .onConflictDoUpdate({
        target: schema.pushSubscriptions.endpoint,
        set: { userId: req.user!.id, p256dh: b.data.keys.p256dh, auth: b.data.keys.auth },
      });
    dlog('push', `subscribe user=${sid(req.user!.id)} SAVED endpoint=…${b.data.endpoint.slice(-12)}`);
    return reply.send({ ok: true });
  });

  // Self-test: fire a REAL web push to the caller's own devices, bypassing the event flow. Lets a
  // user verify end-to-end push delivery on THIS device in one click — no second account, no board.
  // Logs the subscription count + per-endpoint send result via [srv:push].
  app.post('/api/notifications/test', async (req, reply) => {
    dlog('push', `TEST push requested by user=${sid(req.user!.id)}`);
    await pushToUser(req.user!.id, {
      title: 'Test push ✅',
      body: 'If you see this as a system notification, web push works on this device.',
      tabId: null,
    });
    return reply.send({ ok: true });
  });
}
