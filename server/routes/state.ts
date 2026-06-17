import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/guard.ts';
import { assembleState } from '../lib/assembleState.ts';

export async function stateRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/state', { preHandler: requireAuth }, async (req) => {
    return assembleState(req.user!.id);
  });
}
