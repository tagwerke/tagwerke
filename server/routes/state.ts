import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/guard.ts';
import { patReaches } from '../auth/pat.ts';
import { assembleState } from '../lib/assembleState.ts';

export async function stateRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/state', { preHandler: requireAuth, config: { pat: 'read' } }, async (req) => {
    // A token sees only the boards it reaches (the filter is a no-op for a cookie session).
    return assembleState(req.user!.id, (tabId) => patReaches(req, tabId));
  });
}
