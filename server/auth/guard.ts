import type { FastifyReply, FastifyRequest } from 'fastify';
import { resolveUser, type SessionUser } from './session.ts';

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

/** preHandler that requires a logged-in user; replies 401 and stops otherwise. */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = await resolveUser(req);
  if (!user) {
    reply.code(401).send({ error: 'unauthenticated' });
    return;
  }
  req.user = user;
}

/** preHandler that requires a platform admin. Replies 401/403 and stops otherwise. */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = await resolveUser(req);
  if (!user) {
    reply.code(401).send({ error: 'unauthenticated' });
    return;
  }
  if (user.role !== 'admin') {
    reply.code(403).send({ error: 'admin only' });
    return;
  }
  req.user = user;
}
