// Notification feed routes (NOTIFICATIONS.md). Everything here is scoped to the CURRENT user
// (req.user.id) — a notification belongs to exactly one recipient, so there's no board-role
// check, just requireAuth. Rows are emitted elsewhere (server/lib/notify.ts); these routes only
// read the feed, flip read state, and manage this user's push subscriptions.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { requireAuth } from '../auth/guard.ts';
import { vapidPublicKey } from '../lib/webpush.ts';

const FEED_LIMIT = 50;

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

  // The latest slice of this user's feed + the current unread count (for the bell badge).
  app.get('/api/notifications', async (req) => {
    const userId = req.user!.id;
    const rows = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, userId))
      .orderBy(desc(schema.notifications.createdAt))
      .limit(FEED_LIMIT);
    const unread = (
      await db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.notifications)
        .where(and(eq(schema.notifications.userId, userId), isNull(schema.notifications.readAt)))
    )[0]?.n ?? 0;
    return {
      notifications: rows.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        readAt: r.readAt?.toISOString() ?? null,
      })),
      unread,
    };
  });

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

  // The browser needs the public VAPID key to build a push subscription. null = push disabled
  // (no keys configured) → the client hides the "enable push" affordance.
  app.get('/api/notifications/vapid-key', async () => {
    return { key: vapidPublicKey() };
  });

  // Register (or refresh) a device push subscription for this user. Upsert on the unique endpoint
  // so re-subscribing the same browser is idempotent and re-points it at the current user.
  app.post('/api/notifications/subscribe', async (req, reply) => {
    const b = subscribeBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid subscription' });
    await db
      .insert(schema.pushSubscriptions)
      .values({ id: nanoid(), userId: req.user!.id, endpoint: b.data.endpoint, p256dh: b.data.keys.p256dh, auth: b.data.keys.auth })
      .onConflictDoUpdate({
        target: schema.pushSubscriptions.endpoint,
        set: { userId: req.user!.id, p256dh: b.data.keys.p256dh, auth: b.data.keys.auth },
      });
    return reply.send({ ok: true });
  });
}
