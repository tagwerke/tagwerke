import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { requireAuth } from '../auth/guard.ts';
import { boardRole, requireBoardRole, paramTabId } from '../auth/boards.ts';
import { auditEdit, diffChanges, recordAudit } from '../lib/audit.ts';

// Opt-in per-board guardrails (AUDIT_IMPLEMENTATION_PLAN §F4). Admin-only to change.
const settingsBody = z.object({
  requireReview: z.boolean().optional(),
  restrictDelete: z.union([z.literal('admin'), z.null()]).optional(),
});
type BoardSettings = { requireReview?: boolean; restrictDelete?: 'admin' };

/** Merge a settings patch onto the stored bag; a null clears that key. */
function mergeSettings(existing: BoardSettings, patch: z.infer<typeof settingsBody>): BoardSettings {
  const out: BoardSettings = { ...existing };
  if (patch.requireReview !== undefined) out.requireReview = patch.requireReview;
  if (patch.restrictDelete !== undefined) {
    if (patch.restrictDelete === null) delete out.restrictDelete;
    else out.restrictDelete = patch.restrictDelete;
  }
  return out;
}

const createBody = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1).max(200),
  position: z.number().int().nonnegative(),
  starred: z.boolean().optional(),
  type: z.enum(['normal']).optional(),
});

const patchBody = z.object({
  // Content (lives on the shared tab). NOTE: the rich-text document is NOT here — it syncs as a
  // Yjs CRDT over the socket and is persisted by server/realtime/ydoc.ts, never via this PATCH.
  name: z.string().min(1).max(200).optional(),
  dateKey: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  // Board guardrails (admin-only; lives on the shared tab):
  settings: settingsBody.optional(),
  // Per-user view state (lives on this caller's board_members row):
  projectId: z.string().min(1).optional(), // = the caller's category
  starred: z.boolean().optional(),
  starredPosition: z.number().int().nonnegative().nullable().optional(),
});

const reorderBody = z.object({ order: z.array(z.string().min(1)) });

export async function tabRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // Fetch just one board's document + its version. Used by live updates (C2/C3): a peer's
  // 'doc' broadcast carries the version only, so the client pulls the fresh blob from here.
  app.get(
    '/api/tabs/:id/doc',
    { preHandler: requireBoardRole('viewer', paramTabId) },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const row = (
        await db
          .select({ docJSON: schema.tabs.docJSON, docVersion: schema.tabs.docVersion })
          .from(schema.tabs)
          .where(eq(schema.tabs.id, id))
          .limit(1)
      )[0];
      if (!row) return reply.code(404).send({ error: 'not found' });
      return reply.send({ docJSON: row.docJSON ?? null, docVersion: row.docVersion });
    },
  );

  app.post('/api/tabs', async (req, reply) => {
    const b = createBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid tab' });
    const userId = req.user!.id;
    const starred = b.data.starred ?? false;
    await db.transaction(async (tx) => {
      // Shared content only; created_by is attribution. Per-user view state
      // (category/order/starred) lives on the membership row below.
      await tx.insert(schema.tabs).values({
        id: b.data.id,
        createdBy: userId,
        name: b.data.name,
        type: b.data.type ?? 'normal',
      });
      // The creator's membership = admin. Carries this user's view state.
      await tx.insert(schema.boardMembers).values({
        tabId: b.data.id,
        userId,
        role: 'admin',
        categoryId: b.data.projectId,
        position: b.data.position,
        starred,
      });
    });
    return reply.code(201).send({ ok: true });
  });

  app.patch('/api/tabs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = patchBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid patch' });
    const userId = req.user!.id;

    // Split three ways: shared content (name/dateKey/location), admin guardrails (settings), and
    // this caller's personal view state (category/starred). The document is NOT handled here.
    const { projectId, starred, starredPosition, settings, ...contentRest } = b.data;
    const editingContent = Object.keys(contentRest).length > 0;

    // Authorize: must be a member; content requires editor+; settings require admin.
    const role = await boardRole(userId, id);
    if (!role) return reply.code(404).send({ error: 'not found' });
    if (editingContent && role === 'viewer')
      return reply.code(403).send({ error: 'insufficient permission' });
    if (settings !== undefined && role !== 'admin')
      return reply.code(403).send({ error: 'only admins may change board settings' });

    // Prior row: for content diffs + settings merge.
    const before = (await db.select().from(schema.tabs).where(eq(schema.tabs.id, id)).limit(1))[0];
    if (!before) return reply.code(404).send({ error: 'not found' });

    const contentToWrite: Record<string, unknown> = { ...contentRest };
    const mergedSettings =
      settings !== undefined ? mergeSettings((before.settings as BoardSettings) ?? {}, settings) : undefined;

    const memberPatch: Record<string, unknown> = {};
    if (projectId !== undefined) memberPatch.categoryId = projectId;
    if (starred !== undefined) memberPatch.starred = starred;
    if (starredPosition !== undefined) memberPatch.starredPosition = starredPosition;

    await db.transaction(async (tx) => {
      if (Object.keys(contentToWrite).length) {
        await tx.update(schema.tabs).set(contentToWrite).where(eq(schema.tabs.id, id));
      }
      if (mergedSettings) {
        await tx.update(schema.tabs).set({ settings: mergedSettings }).where(eq(schema.tabs.id, id));
      }
      if (Object.keys(memberPatch).length) {
        await tx
          .update(schema.boardMembers)
          .set(memberPatch)
          .where(and(eq(schema.boardMembers.tabId, id), eq(schema.boardMembers.userId, userId)));
      }
    });

    // Attribution: diff scalar content. Settings changes get an explicit structural row.
    const changes = diffChanges(before as Record<string, unknown>, contentRest, ['name', 'dateKey', 'location']);
    auditEdit(req, { action: 'PATCH /api/tabs/:id', targetType: 'tab', targetId: id, scopeId: id, changes });
    if (mergedSettings) {
      recordAudit({
        actorId: userId, action: 'board_settings_change', targetType: 'tab', targetId: id,
        scopeId: id, method: 'PATCH', status: 200, payload: { settings: mergedSettings },
      });
    }

    return reply.send({ ok: true });
  });

  app.post('/api/tabs/reorder', async (req, reply) => {
    const b = reorderBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid order' });
    const userId = req.user!.id;
    await db.transaction(async (tx) => {
      for (let i = 0; i < b.data.order.length; i++) {
        await tx
          .update(schema.boardMembers)
          .set({ position: i })
          .where(and(eq(schema.boardMembers.tabId, b.data.order[i]), eq(schema.boardMembers.userId, userId)));
      }
    });
    return reply.send({ ok: true });
  });

  app.post('/api/tabs/reorder-starred', async (req, reply) => {
    const b = reorderBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid order' });
    const userId = req.user!.id;
    await db.transaction(async (tx) => {
      for (let i = 0; i < b.data.order.length; i++) {
        await tx
          .update(schema.boardMembers)
          .set({ starredPosition: i })
          .where(and(eq(schema.boardMembers.tabId, b.data.order[i]), eq(schema.boardMembers.userId, userId)));
      }
    });
    return reply.send({ ok: true });
  });

  // Deleting a board removes it for EVERYONE (admin action). To drop only your own
  // access, leave the board via DELETE /api/tabs/:id/members/:me (members route).
  app.delete(
    '/api/tabs/:id',
    { preHandler: requireBoardRole('admin', paramTabId) },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const before = (await db.select({ name: schema.tabs.name }).from(schema.tabs).where(eq(schema.tabs.id, id)).limit(1))[0];
      // Deleting the tab cascades its tasks, memberships, events, and the time_blocks
      // that reference it (all FK on delete cascade). (Delete requires admin via preHandler,
      // so the per-board restrictDelete guardrail is already satisfied.)
      await db.delete(schema.tabs).where(eq(schema.tabs.id, id));
      req.auditHandled = true;
      recordAudit({
        actorId: req.user!.id, action: 'DELETE /api/tabs/:id', targetType: 'tab', targetId: id,
        scopeId: id, method: 'DELETE', status: 200, payload: before ? { snapshot: { name: before.name } } : null,
      });
      return reply.send({ ok: true });
    },
  );
}
