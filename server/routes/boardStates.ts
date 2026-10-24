// Editing a board's task states (BOARD_STATES_PLAN P2).
//
//   POST   /api/tabs/:id/states         add a state
//   PATCH  /api/tabs/:id/states/:key    rename, recolor, describe, re-categorize, hide
//   PUT    /api/tabs/:id/states/order   reorder
//   DELETE /api/tabs/:id/states/:key    delete, moving the tasks that use it
//
// Board admins only, and never a token (D11): no route declares `config.pat`, so tokens are refused
// by default. States arrive with /api/state, so there is no GET. After every write the board's
// clients get the whole list in one `board-states` frame — paths under /api/tabs are skipped by the
// generic broadcast hook, so the publish here is the only one.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { requireAuth } from '../auth/guard.ts';
import { requireBoardRole, paramTabId } from '../auth/boards.ts';
import { recordAudit, diffChanges, type FieldChange } from '../lib/audit.ts';
import { boardChannel, publish } from '../lib/bus.ts';
import { taskDTO } from '../lib/assembleState.ts';
import { invalidate, liveStates } from '../lib/boardStates.ts';
import {
  CATEGORY_DEFAULT_COLOR, MAX_STATES, REQUIRED_CATEGORIES, STATE_COLORS, STATUS_CATEGORIES,
  type BoardState, type StatusCategory,
} from '../../shared/status.ts';

const label = z.string().transform((s) => s.trim()).pipe(z.string().min(1).max(40));
// An empty description is no description.
const description = z.string().transform((s) => s.trim() || null).pipe(z.string().max(200).nullable()).nullable();
const category = z.enum(STATUS_CATEGORIES);
const color = z.enum(STATE_COLORS);

const createBody = z.object({ label, category, color: color.optional(), description: description.optional() });
const patchBody = z.object({
  label: label.optional(),
  color: color.optional(),
  description: description.optional(),
  category: category.optional(),
  hidden: z.boolean().optional(),
});
const orderBody = z.object({ keys: z.array(z.string().min(1)) });
const deleteBody = z.object({ moveTo: z.string().min(1).optional() }).optional();

const EDITABLE = ['label', 'color', 'description', 'category', 'hidden'] as const;

const labelTaken = (states: BoardState[], value: string, except?: string): boolean =>
  states.some((s) => s.key !== except && s.label.toLowerCase() === value.toLowerCase());

/** The first required category (D2) the list would no longer have a visible state of, or null. */
function missingRequired(states: Pick<BoardState, 'category' | 'hidden'>[]): StatusCategory | null {
  return REQUIRED_CATEGORIES.find((c) => !states.some((s) => s.category === c && !s.hidden)) ?? null;
}

/** Push the new list to the board and put the edit on its history (D10). */
async function afterWrite(
  req: FastifyRequest,
  tabId: string,
  op: 'create' | 'update' | 'reorder' | 'delete',
  stateLabel: string | null,
  extra: Record<string, unknown>,
): Promise<BoardState[]> {
  invalidate(tabId);
  const states = await liveStates(tabId);
  publish(boardChannel(tabId), { v: 1, type: 'board-states', tabId, states, actorId: req.user!.id });
  req.auditHandled = true;
  recordAudit({
    actorId: req.user!.id, action: 'board_state_change', targetType: 'tab', targetId: tabId,
    scopeId: tabId, method: req.method, status: 200,
    payload: { op, ...(stateLabel != null ? { state: stateLabel } : {}), ...extra },
  });
  return states;
}

export async function boardStateRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);
  const admin = { preHandler: requireBoardRole('admin', paramTabId) };

  app.post('/api/tabs/:id/states', admin, async (req, reply) => {
    const { id: tabId } = req.params as { id: string };
    const b = createBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid state' });
    const states = await liveStates(tabId);
    if (states.length >= MAX_STATES) return reply.code(400).send({ error: 'too_many_states', max: MAX_STATES });
    if (labelTaken(states, b.data.label)) return reply.code(400).send({ error: 'label_taken' });

    const state: BoardState = {
      key: `s_${nanoid(8)}`,
      label: b.data.label,
      description: b.data.description ?? null,
      category: b.data.category,
      color: b.data.color ?? CATEGORY_DEFAULT_COLOR[b.data.category],
      position: states.reduce((max, s) => Math.max(max, s.position), -1) + 1,
      hidden: false,
    };
    await db.insert(schema.boardStates).values({ id: nanoid(), tabId, ...state });
    const changes: FieldChange[] = (['label', 'category', 'color', 'description'] as const)
      .filter((f) => state[f] != null)
      .map((f) => ({ field: f, from: null, to: state[f] }));
    const list = await afterWrite(req, tabId, 'create', state.label, { changes });
    return reply.code(201).send({ ok: true, state, states: list });
  });

  // Registered before `/:key` would matter only for the same method; it is a different one, and a
  // state key is never `order` (custom keys are `s_…`).
  app.put('/api/tabs/:id/states/order', admin, async (req, reply) => {
    const { id: tabId } = req.params as { id: string };
    const b = orderBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid order' });
    const states = await liveStates(tabId);
    const keys = b.data.keys;
    const same = keys.length === states.length && new Set(keys).size === keys.length && states.every((s) => keys.includes(s.key));
    if (!same) return reply.code(400).send({ error: 'order must list every state exactly once' });
    const now = new Date();
    await db.transaction(async (tx) => {
      for (const [position, key] of keys.entries()) {
        await tx
          .update(schema.boardStates)
          .set({ position, updatedAt: now })
          .where(and(eq(schema.boardStates.tabId, tabId), eq(schema.boardStates.key, key)));
      }
    });
    const before = states.map((s) => s.label);
    const after = keys.map((k) => states.find((s) => s.key === k)!.label);
    const list = await afterWrite(req, tabId, 'reorder', null, { changes: [{ field: 'order', from: before, to: after }] });
    return reply.send({ ok: true, states: list });
  });

  app.patch('/api/tabs/:id/states/:key', admin, async (req, reply) => {
    const { id: tabId, key } = req.params as { id: string; key: string };
    const b = patchBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid state' });
    const states = await liveStates(tabId);
    const current = states.find((s) => s.key === key);
    if (!current) return reply.code(404).send({ error: 'not found' });
    if (b.data.label !== undefined && labelTaken(states, b.data.label, key)) return reply.code(400).send({ error: 'label_taken' });

    const next = { ...current, ...b.data };
    const missing = missingRequired(states.map((s) => (s.key === key ? next : s)));
    if (missing) return reply.code(409).send({ error: 'required_category', category: missing });

    const changes = diffChanges(current as unknown as Record<string, unknown>, b.data, EDITABLE);
    if (!changes.length) {
      req.auditHandled = true;
      return reply.send({ ok: true, state: current, states });
    }
    await db
      .update(schema.boardStates)
      .set({ ...b.data, updatedAt: new Date() })
      .where(and(eq(schema.boardStates.tabId, tabId), eq(schema.boardStates.key, key)));
    // Named by the label it had: "renamed Contacted to Reached" reads from the old name.
    const list = await afterWrite(req, tabId, 'update', current.label, { changes });
    return reply.send({ ok: true, state: next, states: list });
  });

  app.delete('/api/tabs/:id/states/:key', admin, async (req, reply) => {
    const { id: tabId, key } = req.params as { id: string; key: string };
    const b = deleteBody.safeParse(req.body ?? undefined);
    if (!b.success) return reply.code(400).send({ error: 'invalid request' });
    const moveTo = b.data?.moveTo;
    const states = await liveStates(tabId);
    const current = states.find((s) => s.key === key);
    if (!current) return reply.code(404).send({ error: 'not found' });
    const missing = missingRequired(states.filter((s) => s.key !== key));
    if (missing) return reply.code(409).send({ error: 'required_category', category: missing });

    // Trash included: a task restored later must land on a state that exists.
    const count = Number(
      (await db
        .select({ n: sql<number>`count(*)` })
        .from(schema.tasks)
        .where(and(eq(schema.tasks.homeTabId, tabId), eq(schema.tasks.status, key))))[0]?.n ?? 0,
    );
    const target = moveTo ? states.find((s) => s.key === moveTo && s.key !== key) : undefined;
    if (count > 0 && !target) return reply.code(400).send({ error: 'move_required', count });

    const now = new Date();
    const movedIds = await db.transaction(async (tx) => {
      const moved = count
        ? await tx
            .update(schema.tasks)
            .set({ status: target!.key, updatedAt: now })
            .where(and(eq(schema.tasks.homeTabId, tabId), eq(schema.tasks.status, key)))
            .returning({ id: schema.tasks.id })
        : [];
      await tx
        .update(schema.boardStates)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(schema.boardStates.tabId, tabId), eq(schema.boardStates.key, key)));
      // A meeting's agenda filter naming this state would otherwise filter on a key no task can
      // have. An emptied list means "every status", which is what the editor stores as no key.
      await tx.execute(sql`
        UPDATE events
           SET filter = CASE
             WHEN jsonb_array_length(filter->'statuses') = 1 THEN filter - 'statuses'
             ELSE jsonb_set(filter, '{statuses}', (filter->'statuses') - ${key}::text)
           END
         WHERE tab_id = ${tabId} AND filter->'statuses' ? ${key}::text
      `);
      return moved.map((r) => r.id);
    });

    // The state event is the record for the moved tasks; they get no per-task rows.
    const list = await afterWrite(req, tabId, 'delete', current.label, {
      movedTasks: count,
      ...(target ? { moveTo: target.key, moveToLabel: target.label } : {}),
    });
    if (movedIds.length) {
      const rows = await db.select().from(schema.tasks).where(and(inArray(schema.tasks.id, movedIds), isNull(schema.tasks.deletedAt)));
      for (const row of rows) {
        publish(boardChannel(tabId), { v: 1, type: 'entity', entity: 'task', id: row.id, action: 'PUT', patch: taskDTO(row), actorId: req.user!.id });
      }
    }
    return reply.send({ ok: true, movedTasks: count, states: list });
  });
}
