// Commitments extracted from a document (CONTRACT_TO_PROJECT_PLAN rung 3).
//
// STUB — the real implementation is Agent C's. It exists now only so the tree typechecks while the
// routes are being written; every endpoint answers 503. Replace wholesale, do not build on this.

import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/guard.ts';

export async function itemRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAuth);

  const notBuilt = async (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) =>
    reply.code(503).send({ error: 'commitment extraction is not available yet' });

  app.post('/api/documents/:id/extract', notBuilt);
  app.get('/api/documents/:id/items', notBuilt);
  app.patch('/api/items/:id', notBuilt);
  app.post('/api/documents/:id/items/accept-all', notBuilt);
}
