// Editing a board's custom fields (CUSTOM_FIELDS_PLAN P2.2).
//
//   POST   /api/tabs/:id/fields         add a field (label, type, optional key)
//   PATCH  /api/tabs/:id/fields/:key    rename, hide
//   PUT    /api/tabs/:id/fields/order   reorder
//   DELETE /api/tabs/:id/fields/:key    delete (a tombstone)
//
// Board admins only, and never a token (D1, D9): no route declares `config.pat`, so tokens are
// refused by default; a token sets fields only when it creates the board (routes/tabs.ts). Fields
// arrive with /api/state, so there is no GET. After every write the board's clients get the whole
// list in one `board-fields` frame — paths under /api/tabs are skipped by the generic broadcast
// hook, so the publish here is the only one.
//
// A field's type never changes (D2), and deleting one leaves its values in tasks.fields: history
// still resolves them, but nothing shows or writes them any more.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { requireAuth } from '../auth/guard.ts';
import { requireBoardRole, paramTabId } from '../auth/boards.ts';
import { recordAudit, diffChanges, type FieldChange } from '../lib/audit.ts';
import { boardChannel, publish } from '../lib/bus.ts';
import { fieldsOf, insertBoardFields, invalidate, liveFields, planFields } from '../lib/boardFields.ts';
import type { BoardField } from '../../shared/fields.ts';

const label = z.string().transform((s) => s.trim()).pipe(z.string().min(1).max(40));

const createBody = z.object({ label, type: z.string(), key: z.string().optional() });
const patchBody = z.object({ label: label.optional(), hidden: z.boolean().optional() });
const orderBody = z.object({ keys: z.array(z.string().min(1)) });

const EDITABLE = ['label', 'hidden'] as const;

/** Push the new list to the board and put the edit on its history. */
async function afterWrite(
  req: FastifyRequest,
  tabId: string,
  op: 'create' | 'update' | 'reorder' | 'delete',
  fieldLabel: string | null,
  extra: Record<string, unknown>,
): Promise<BoardField[]> {
  invalidate(tabId);
  const fields = await liveFields(tabId);
  publish(boardChannel(tabId), { v: 1, type: 'board-fields', tabId, fields, actorId: req.user!.id });
  req.auditHandled = true;
  recordAudit({
    actorId: req.user!.id, action: 'board_field_change', targetType: 'tab', targetId: tabId,
    scopeId: tabId, method: req.method, status: 200,
    payload: { op, ...(fieldLabel != null ? { fieldLabel } : {}), ...extra },
  });
  return fields;
}

export async function boardFieldRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  const admin = { preHandler: requireBoardRole('admin', paramTabId) };

  app.post('/api/tabs/:id/fields', admin, async (req, reply) => {
    const { id: tabId } = req.params as { id: string };
    const b = createBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid field' });
    const plan = planFields(await fieldsOf(tabId), [b.data]);
    if (!plan.ok) return reply.code(400).send(plan.body);
    const field = plan.fields[0];
    await insertBoardFields(db, tabId, plan.fields);
    const changes: FieldChange[] = [
      { field: 'label', from: null, to: field.label },
      { field: 'type', from: null, to: field.type },
    ];
    const list = await afterWrite(req, tabId, 'create', field.label, { changes });
    return reply.code(201).send({ ok: true, field, fields: list });
  });

  // A different method from `/:key`, so a field keyed `order` is never shadowed.
  app.put('/api/tabs/:id/fields/order', admin, async (req, reply) => {
    const { id: tabId } = req.params as { id: string };
    const b = orderBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid order' });
    const fields = await liveFields(tabId);
    const keys = b.data.keys;
    const same = keys.length === fields.length && new Set(keys).size === keys.length && fields.every((f) => keys.includes(f.key));
    if (!same) return reply.code(400).send({ error: 'order must list every field exactly once' });
    const now = new Date();
    await db.transaction(async (tx) => {
      for (const [position, key] of keys.entries()) {
        await tx
          .update(schema.boardFields)
          .set({ position, updatedAt: now })
          .where(and(eq(schema.boardFields.tabId, tabId), eq(schema.boardFields.key, key)));
      }
    });
    const before = fields.map((f) => f.label);
    const after = keys.map((k) => fields.find((f) => f.key === k)!.label);
    const list = await afterWrite(req, tabId, 'reorder', null, { changes: [{ field: 'order', from: before, to: after }] });
    return reply.send({ ok: true, fields: list });
  });

  app.patch('/api/tabs/:id/fields/:key', admin, async (req, reply) => {
    const { id: tabId, key } = req.params as { id: string; key: string };
    const b = patchBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid field' });
    const fields = await liveFields(tabId);
    const current = fields.find((f) => f.key === key);
    if (!current) return reply.code(404).send({ error: 'not found' });
    if (b.data.label !== undefined && fields.some((f) => f.key !== key && f.label.toLowerCase() === b.data.label!.toLowerCase()))
      return reply.code(400).send({ error: 'label_taken' });

    const changes = diffChanges(current as unknown as Record<string, unknown>, b.data, EDITABLE);
    if (!changes.length) {
      req.auditHandled = true;
      return reply.send({ ok: true, field: current, fields });
    }
    await db
      .update(schema.boardFields)
      .set({ ...b.data, updatedAt: new Date() })
      .where(and(eq(schema.boardFields.tabId, tabId), eq(schema.boardFields.key, key)));
    // Named by the label it had: "renamed Site to Website" reads from the old name.
    const list = await afterWrite(req, tabId, 'update', current.label, { changes });
    return reply.send({ ok: true, field: { ...current, ...b.data }, fields: list });
  });

  app.delete('/api/tabs/:id/fields/:key', admin, async (req, reply) => {
    const { id: tabId, key } = req.params as { id: string; key: string };
    const current = (await liveFields(tabId)).find((f) => f.key === key);
    if (!current) return reply.code(404).send({ error: 'not found' });
    const now = new Date();
    await db
      .update(schema.boardFields)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(schema.boardFields.tabId, tabId), eq(schema.boardFields.key, key)));
    const list = await afterWrite(req, tabId, 'delete', current.label, {});
    return reply.send({ ok: true, fields: list });
  });
}
