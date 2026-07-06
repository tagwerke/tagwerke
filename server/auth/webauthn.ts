// Passkeys (WebAuthn) — passwordless, phishing-resistant login. Registration attaches a
// credential to the logged-in account; authentication is usernameless (discoverable keys).
// A passkey login is strong single-step: no password, no TOTP on top (same trust model as
// SSO). The crypto is handled by @simplewebauthn/server. See AUTH_IMPLEMENTATION_PLAN.md (Slice 8).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { db, schema } from '../db/client.ts';
import { requireAuth } from './guard.ts';
import { cookieSecure, createSession, setSessionCookie } from './session.ts';
import { recordAudit } from '../lib/audit.ts';
import { appUrl } from '../lib/email.ts';

const WEBAUTHN_COOKIE = 'do_webauthn';
const rateLimit = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

// RP identity is derived from APP_URL so every self-hosted instance binds passkeys to its
// own domain (rpID = host, origin = full origin).
function rp(): { rpID: string; origin: string; rpName: string } {
  const url = new URL(appUrl());
  return { rpID: url.hostname, origin: url.origin, rpName: process.env.ORG_NAME ?? 'do' };
}

function setChallenge(req: FastifyRequest, reply: FastifyReply, challenge: string): void {
  reply.setCookie(WEBAUTHN_COOKIE, challenge, { path: '/', httpOnly: true, sameSite: 'lax', secure: cookieSecure(req), signed: true, maxAge: 300 });
}
function readChallenge(req: FastifyRequest): string | null {
  const raw = req.cookies[WEBAUTHN_COOKIE];
  if (!raw) return null;
  const u = req.unsignCookie(raw);
  return u.valid && u.value ? u.value : null;
}
const clearChallenge = (reply: FastifyReply) => reply.clearCookie(WEBAUTHN_COOKIE, { path: '/' });

// Reused by the admin step-up (sudo) passkey ceremony in routes/sudo.ts.
export const webauthnRp = rp;
export const setWebauthnChallenge = setChallenge;
export const readWebauthnChallenge = readChallenge;
export const clearWebauthnChallenge = clearChallenge;

export async function passkeyRoutes(app: FastifyInstance): Promise<void> {
  // ── Registration (attaches a passkey to the logged-in account) ──────────────
  app.post('/api/auth/passkey/register/options', { ...rateLimit, preHandler: requireAuth }, async (req, reply) => {
    const userId = req.user!.id;
    const existing = await db
      .select({ credentialId: schema.webauthnCredentials.credentialId, transports: schema.webauthnCredentials.transports })
      .from(schema.webauthnCredentials)
      .where(eq(schema.webauthnCredentials.userId, userId));
    const { rpID, rpName } = rp();
    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userName: req.user!.email,
      userID: new TextEncoder().encode(userId),
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: (c.transports as AuthenticatorTransportFuture[] | null) ?? undefined })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    setChallenge(req, reply, options.challenge);
    return options;
  });

  app.post('/api/auth/passkey/register/verify', { ...rateLimit, preHandler: requireAuth }, async (req, reply) => {
    const userId = req.user!.id;
    const challenge = readChallenge(req);
    clearChallenge(reply);
    if (!challenge) return reply.code(400).send({ error: 'no challenge' });
    const body = req.body as { response: RegistrationResponseJSON; nickname?: string };
    const { rpID, origin } = rp();

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.response,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: false,
      });
    } catch (err) {
      req.log.error({ err }, 'passkey registration verify failed');
      return reply.code(400).send({ error: 'verification failed' });
    }
    if (!verification.verified || !verification.registrationInfo) return reply.code(400).send({ error: 'not verified' });

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    await db.insert(schema.webauthnCredentials).values({
      id: nanoid(),
      userId,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      transports: credential.transports ?? null,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      nickname: body.nickname?.trim() || 'Passkey',
    });
    recordAudit({ actorId: userId, action: 'passkey_registered', targetType: 'user', targetId: userId, status: 200 });
    return reply.send({ ok: true });
  });

  // ── Authentication (usernameless; no session required) ──────────────────────
  app.post('/api/auth/passkey/login/options', rateLimit, async (req, reply) => {
    const { rpID } = rp();
    // Empty allowCredentials → the browser offers any discoverable passkey for this RP.
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
    setChallenge(req, reply, options.challenge);
    return options;
  });

  app.post('/api/auth/passkey/login/verify', rateLimit, async (req, reply) => {
    const challenge = readChallenge(req);
    clearChallenge(reply);
    if (!challenge) return reply.code(400).send({ error: 'no challenge' });
    const body = req.body as { response: AuthenticationResponseJSON };
    const credId = body.response?.id;
    if (!credId) return reply.code(400).send({ error: 'invalid response' });

    const credRows = await db.select().from(schema.webauthnCredentials).where(eq(schema.webauthnCredentials.credentialId, credId)).limit(1);
    const cred = credRows[0];
    if (!cred) return reply.code(401).send({ error: 'unknown credential' });

    const userRows = await db
      .select({ id: schema.users.id, email: schema.users.email, role: schema.users.role, totpEnabled: schema.users.totpEnabled, deactivatedAt: schema.users.deactivatedAt })
      .from(schema.users)
      .where(eq(schema.users.id, cred.userId))
      .limit(1);
    const user = userRows[0];
    if (!user) return reply.code(401).send({ error: 'unknown user' });
    if (user.deactivatedAt) {
      recordAudit({ actorId: null, action: 'login_deactivated', targetType: 'user', targetId: user.id, payload: { via: 'passkey' }, status: 403 });
      return reply.code(403).send({ error: 'account deactivated' });
    }

    const { rpID, origin } = rp();
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body.response,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: cred.credentialId,
          publicKey: new Uint8Array(Buffer.from(cred.publicKey, 'base64url')),
          counter: cred.counter,
          transports: (cred.transports as AuthenticatorTransportFuture[] | null) ?? undefined,
        },
        requireUserVerification: false,
      });
    } catch (err) {
      req.log.error({ err }, 'passkey authentication verify failed');
      return reply.code(401).send({ error: 'verification failed' });
    }
    if (!verification.verified) return reply.code(401).send({ error: 'not verified' });

    await db
      .update(schema.webauthnCredentials)
      .set({ counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date() })
      .where(eq(schema.webauthnCredentials.id, cred.id));

    const sessionId = await createSession(user.id);
    setSessionCookie(req, reply, sessionId);
    recordAudit({ actorId: user.id, action: 'passkey_login', targetType: 'user', targetId: user.id, status: 200 });
    return reply.send({ user: { id: user.id, email: user.email, role: user.role === 'admin' ? 'admin' : 'member', totpEnabled: user.totpEnabled } });
  });

  // ── Management (authenticated) ──────────────────────────────────────────────
  app.get('/api/auth/passkey', { preHandler: requireAuth }, async (req) => {
    const rows = await db
      .select({ id: schema.webauthnCredentials.id, nickname: schema.webauthnCredentials.nickname, createdAt: schema.webauthnCredentials.createdAt, lastUsedAt: schema.webauthnCredentials.lastUsedAt, deviceType: schema.webauthnCredentials.deviceType })
      .from(schema.webauthnCredentials)
      .where(eq(schema.webauthnCredentials.userId, req.user!.id));
    return { passkeys: rows };
  });

  app.patch('/api/auth/passkey/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z.object({ nickname: z.string().min(1).max(60) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid request' });
    await db
      .update(schema.webauthnCredentials)
      .set({ nickname: b.data.nickname })
      .where(and(eq(schema.webauthnCredentials.id, id), eq(schema.webauthnCredentials.userId, req.user!.id)));
    return reply.send({ ok: true });
  });

  app.delete('/api/auth/passkey/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await db
      .delete(schema.webauthnCredentials)
      .where(and(eq(schema.webauthnCredentials.id, id), eq(schema.webauthnCredentials.userId, req.user!.id)));
    recordAudit({ actorId: req.user!.id, action: 'passkey_removed', targetType: 'user', targetId: req.user!.id, status: 200 });
    return reply.send({ ok: true });
  });
}
