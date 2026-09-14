// Commitments extracted from a document (CONTRACT_TO_PROJECT_PLAN.md rung 3, §3).
//
// Four routes and no more. The pipeline lives in `lib/extractItems.ts`; this file owns the
// authorization, the wire shape, and the three ways the feature can be unavailable — each of which
// has to be legible to the UI, because "the button did nothing" is the failure the panel is
// designed to never show:
//
//   503  the operator never configured an AI endpoint. Names the missing env keys.
//   409  the document has no readable text (a scan, an unsupported type, a failed extract).
//        Carries `textStatus` so the panel can say WHICH, per D4.
//   409  a run is already in flight for this document. Carries the runId so the UI polls instead.
//
// Board scope comes from the denormalized `tab_id` on both tables (D9), so authorization is one
// lookup and reuses `requireBoardRole` exactly as routes/documents.ts does — no new permission
// model, no per-document ACL.
//
// Nothing here is authoritative (D8): rows are `proposed` until a person says otherwise, and the
// document remains the source of truth. This layer never writes to `documents`.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { requireAuth } from '../auth/guard.ts';
import { requireBoardRole } from '../auth/boards.ts';
import { aiConfigured, missingAiConfig } from '../lib/ai.ts';
import { runDTO, startExtraction, runState } from '../lib/extractItems.ts';

// One extraction is one LLM call per 12k characters — the most expensive thing a board member can
// trigger, and unlike a task edit there is no legitimate reason to issue them in a loop. Mirrors
// UPLOAD_RL in routes/documents.ts.
const EXTRACT_RL = { max: 10, timeWindow: '1 minute' } as const;

const patchBody = z.object({
  // `proposed` is deliberately absent: this endpoint records a human decision, and there is no
  // "un-decide" in the review gate. Re-running extraction cannot undo it either (D7).
  status: z.enum(['accepted', 'rejected']).optional(),
  text: z.string().min(1).max(500).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

// `sourceQuote` is NOT patchable, and that is a design decision rather than an omission. The quote
// is the server's evidence that the item is real (D6); letting a client rewrite it would turn the
// verified citation into free text and quietly destroy the guarantee. It is also the dedupe key a
// re-run compares against, so a mutable quote would resurrect items a person already edited.

type ItemRow = typeof schema.documentItems.$inferSelect;

function itemDTO(row: ItemRow): Record<string, unknown> {
  return {
    id: row.id,
    documentId: row.documentId,
    kind: row.kind,
    text: row.text,
    sourceQuote: row.sourceQuote,
    sourceOffset: row.sourceOffset ?? undefined,
    dueDate: row.dueDate ?? undefined,
    confidence: row.confidence ?? undefined,
    status: row.status,
    editedAt: row.editedAt instanceof Date ? row.editedAt.getTime() : undefined,
    editedBy: row.editedBy ?? undefined,
  };
}

/** Resolver for routes keyed by a `:id` that is a DOCUMENT id. Same shape as routes/documents.ts. */
const documentBoard = async (req: FastifyRequest): Promise<string | undefined> => {
  const { id } = req.params as { id: string };
  const rows = await db
    .select({ tabId: schema.documents.tabId })
    .from(schema.documents)
    .where(eq(schema.documents.id, id))
    .limit(1);
  return rows[0]?.tabId;
};

/** Resolver for `PATCH /api/items/:id`, where `:id` is an ITEM. Denormalized, so one lookup. */
const itemBoard = async (req: FastifyRequest): Promise<string | undefined> => {
  const { id } = req.params as { id: string };
  const rows = await db
    .select({ tabId: schema.documentItems.tabId })
    .from(schema.documentItems)
    .where(eq(schema.documentItems.id, id))
    .limit(1);
  return rows[0]?.tabId;
};

export async function itemRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  // ---- start a run -----------------------------------------------------------
  // Explicit, never automatic on upload (D1): most uploads are not contracts, and an LLM call per
  // upload is a cost and a latency the uploader did not ask for.
  app.post(
    '/api/documents/:id/extract',
    { preHandler: requireBoardRole('editor', documentBoard), config: { rateLimit: EXTRACT_RL } },
    async (req, reply) => {
      if (!aiConfigured()) {
        // Naming the keys is the whole value of this branch — the panel prints them next to a
        // pointer at .env.example, so an operator is never left guessing which half is missing.
        return reply.code(503).send({
          error: 'commitment extraction is not configured',
          missing: missingAiConfig(),
        });
      }

      const { id } = req.params as { id: string };
      const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, id)).limit(1);
      if (!doc || doc.deletedAt) return reply.code(404).send({ error: 'not found' });

      // D4's payoff. `no_text_layer` means a scan, and extracting commitments from the handful of
      // garbage characters a scan yields is the single worst outcome available here — so the
      // status goes back verbatim and the UI explains it in the document's own terms.
      if (doc.textStatus !== 'ok' || !doc.textContent) {
        return reply.code(409).send({
          error: `this document has no readable text (${doc.textStatus})`,
          textStatus: doc.textStatus,
        });
      }

      const started = startExtraction({
        documentId: id,
        tabId: doc.tabId,
        actorId: req.user!.id,
        text: doc.textContent,
      });
      if (!started) {
        // Refused, not queued: two concurrent runs would each dedupe against the rows that existed
        // when they started and both would insert the same items. The runId lets the UI attach to
        // the run that IS going rather than treating this as a dead end.
        return reply.code(409).send({
          error: 'an extraction run is already in progress for this document',
          runId: runState(id)?.runId,
        });
      }

      // 202, not 200: the run outlives this request by minutes. The UI polls GET .../items, and
      // the board channel gets a `document/extracted` frame when it finishes.
      return reply.code(202).send({ runId: started.runId });
    },
  );

  // ---- read ------------------------------------------------------------------
  app.get(
    '/api/documents/:id/items',
    { preHandler: requireBoardRole('viewer', documentBoard) },
    async (req) => {
      const { id } = req.params as { id: string };
      const rows = await db
        .select()
        .from(schema.documentItems)
        .where(eq(schema.documentItems.documentId, id))
        // Document order, not insertion order: a reviewer reads a contract top to bottom, and the
        // verified offset is the only field that knows where in the contract a clause sits.
        .orderBy(asc(schema.documentItems.sourceOffset), asc(schema.documentItems.createdAt));
      return { items: rows.map(itemDTO), run: runDTO(id) };
    },
  );

  // ---- one human decision ----------------------------------------------------
  app.patch('/api/items/:id', { preHandler: requireBoardRole('editor', itemBoard) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = patchBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid patch' });
    const b = parsed.data;
    if (b.status === undefined && b.text === undefined && b.dueDate === undefined) {
      return reply.code(400).send({ error: 'nothing to change' });
    }

    // editedAt/editedBy are set on EVERY patch, including a bare status change. They are not an
    // audit convenience — they are the flag that makes this row immune to re-extraction (D7), and
    // an accept that did not set them would be silently undone by the next run.
    const [row] = await db
      .update(schema.documentItems)
      .set({
        ...(b.status !== undefined ? { status: b.status } : {}),
        ...(b.text !== undefined ? { text: b.text } : {}),
        ...(b.dueDate !== undefined ? { dueDate: b.dueDate } : {}),
        editedAt: new Date(),
        editedBy: req.user!.id,
      })
      .where(eq(schema.documentItems.id, id))
      .returning();
    if (!row) return reply.code(404).send({ error: 'not found' });

    // No explicit audit row: the generic onResponse hook in lib/audit.ts already logs this as a
    // scoped, body-redacted mutation, and `/api/items` is not a coarse content route.
    return itemDTO(row);
  });

  // ---- accept the lot --------------------------------------------------------
  app.post(
    '/api/documents/:id/items/accept-all',
    { preHandler: requireBoardRole('editor', documentBoard) },
    async (req) => {
      const { id } = req.params as { id: string };
      // `status = 'proposed'` only. An item someone already rejected stays rejected — "accept all"
      // means "accept everything still awaiting a decision", never "overrule every decision made
      // so far", and the second reading is how a bulk button destroys an afternoon of review.
      const rows = await db
        .update(schema.documentItems)
        .set({ status: 'accepted', editedAt: new Date(), editedBy: req.user!.id })
        .where(and(eq(schema.documentItems.documentId, id), eq(schema.documentItems.status, 'proposed')))
        .returning({ id: schema.documentItems.id });
      return { accepted: rows.length };
    },
  );
}
