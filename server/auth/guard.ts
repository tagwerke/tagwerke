import type { FastifyReply, FastifyRequest } from 'fastify';
import { resolveUser, sudoActive, type SessionUser } from './session.ts';

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

/**
 * preHandler that requires a platform admin. A non-admin gets **404 (not 403)** so the
 * admin surface isn't even probeable — mirrors the 404-not-403 board hardening (boards.ts).
 */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = await resolveUser(req);
  if (!user) {
    reply.code(401).send({ error: 'unauthenticated' });
    return;
  }
  if (user.role !== 'admin') {
    reply.code(404).send({ error: 'not found' });
    return;
  }
  req.user = user;
}

/**
 * preHandler that requires a fresh step-up ("sudo") grant. Must run AFTER requireAdmin.
 * Replies 401 `sudo required` when the grant is missing/expired so the client can prompt
 * for re-authentication.
 */
export async function requireSudo(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!(await sudoActive(req))) {
    reply.code(401).send({ error: 'sudo required' });
    return;
  }
}
