// SSO via OpenID Connect (Authorization Code + PKCE). Single provider per instance,
// configured by an admin into `org.config.oidc`. The security-critical parts (discovery,
// PKCE, state/nonce, code exchange, ID-token validation) are handled by `openid-client`.
//
// Flow: /start sets a short-lived signed cookie (state/nonce/verifier) and 302s to the IdP;
// /callback validates, then resolves the user by `oidcSubject` → email (link) → JIT-create
// (domain-gated), establishes a session, and 302s back to the app. See AUTH_IMPLEMENTATION_PLAN.md.

import type { FastifyInstance } from 'fastify';
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import * as oidc from 'openid-client';
import { db, schema } from '../db/client.ts';
import { cookieSecure, createSession, setSessionCookie } from './session.ts';
import { seedUser } from '../lib/seed.ts';
import { recordAudit } from '../lib/audit.ts';
import { appUrl } from '../lib/email.ts';
import { ORG_ID } from '../routes/org.ts';

const OIDC_COOKIE = 'do_oidc';

export interface OidcSettings {
  enabled: boolean;
  issuer: string;
  clientId: string;
  clientSecret: string;
  allowedDomain: string;
  buttonLabel: string;
}

const base = () => appUrl().replace(/\/$/, '');
const redirectUri = () => `${base()}/api/auth/oidc/callback`;

async function readOrgConfig(): Promise<Record<string, unknown>> {
  const rows = await db.select({ config: schema.org.config }).from(schema.org).where(eq(schema.org.id, ORG_ID)).limit(1);
  return (rows[0]?.config as Record<string, unknown> | null) ?? {};
}

/**
 * Resolve the effective OIDC settings. `passwordDisabled` ("disable password login") is
 * forced off unless SSO is fully configured, so it can never lock everyone out (SSO or a
 * passkey remains a way in). Reads `passwordDisabled`, falling back to the legacy `ssoOnly`.
 */
export async function getOidc(): Promise<{ oidc: OidcSettings | null; passwordDisabled: boolean }> {
  const cfg = await readOrgConfig();
  const o = cfg.oidc as Partial<OidcSettings> | undefined;
  const configured = !!(o && o.enabled && o.issuer && o.clientId && o.clientSecret);
  const settings: OidcSettings | null = configured
    ? {
        enabled: true,
        issuer: o!.issuer!,
        clientId: o!.clientId!,
        clientSecret: o!.clientSecret!,
        allowedDomain: (o!.allowedDomain ?? '').toLowerCase(),
        buttonLabel: o!.buttonLabel || 'SSO',
      }
    : null;
  const disabled = cfg.passwordDisabled ?? cfg.ssoOnly; // back-compat with the old key
  return { oidc: settings, passwordDisabled: !!disabled && configured };
}

// Cache the discovered IdP configuration; rebuild whenever issuer/client/secret change.
let discovered: { sig: string; config: oidc.Configuration } | null = null;
async function getDiscovered(o: OidcSettings): Promise<oidc.Configuration> {
  const sig = `${o.issuer}|${o.clientId}|${o.clientSecret}`;
  if (discovered && discovered.sig === sig) return discovered.config;
  const config = await oidc.discovery(new URL(o.issuer), o.clientId, o.clientSecret);
  discovered = { sig, config };
  return config;
}

export async function oidcRoutes(app: FastifyInstance): Promise<void> {
  // Unauthenticated: tells the login screen whether to show the SSO button. No secrets.
  app.get('/api/auth/oidc/public', async () => {
    const { oidc: o, passwordDisabled } = await getOidc();
    return { enabled: !!o, buttonLabel: o?.buttonLabel ?? 'SSO', passwordDisabled };
  });

  // Begin the login: stash state/nonce/PKCE in a signed cookie, redirect to the IdP.
  // An optional `invite` is carried through the flow (in the signed cookie, never validated
  // here) and consumed at /callback ONLY if the login turns out to provision a new account.
  app.get('/api/auth/oidc/start', async (req, reply) => {
    const { oidc: o } = await getOidc();
    if (!o) return reply.redirect(`${base()}/?sso_error=disabled`);
    const config = await getDiscovered(o);

    const verifier = oidc.randomPKCECodeVerifier();
    const challenge = await oidc.calculatePKCECodeChallenge(verifier);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const invite = typeof (req.query as Record<string, unknown>)?.invite === 'string'
      ? String((req.query as Record<string, string>).invite).slice(0, 200)
      : undefined;

    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri(),
      scope: 'openid email profile',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    });

    reply.setCookie(OIDC_COOKIE, JSON.stringify({ state, nonce, verifier, invite }), {
      path: '/', httpOnly: true, sameSite: 'lax', secure: cookieSecure(req), signed: true, maxAge: 600,
    });
    return reply.redirect(url.href);
  });

  // Finish: validate the response, resolve/provision the user, establish a session.
  app.get('/api/auth/oidc/callback', async (req, reply) => {
    const { oidc: o } = await getOidc();
    if (!o) return reply.redirect(`${base()}/?sso_error=disabled`);

    const raw = req.cookies[OIDC_COOKIE];
    const unsigned = raw ? req.unsignCookie(raw) : { valid: false as const, value: null };
    reply.clearCookie(OIDC_COOKIE, { path: '/' });
    if (!unsigned.valid || !unsigned.value) return reply.redirect(`${base()}/?sso_error=state`);
    let saved: { state: string; nonce: string; verifier: string; invite?: string };
    try {
      saved = JSON.parse(unsigned.value);
    } catch {
      return reply.redirect(`${base()}/?sso_error=state`);
    }

    const config = await getDiscovered(o);
    let claims: Record<string, unknown>;
    let accessToken: string;
    try {
      const tokens = await oidc.authorizationCodeGrant(config, new URL(base() + req.url), {
        pkceCodeVerifier: saved.verifier,
        expectedState: saved.state,
        expectedNonce: saved.nonce,
        idTokenExpected: true,
      });
      claims = (tokens.claims() as Record<string, unknown>) ?? {};
      accessToken = tokens.access_token;
    } catch (err) {
      req.log.error({ err }, 'oidc callback exchange failed');
      return reply.redirect(`${base()}/?sso_error=exchange`);
    }

    const sub = String(claims.sub ?? '');
    let email = (claims.email as string | undefined)?.toLowerCase();
    // Some IdPs only return email from the userinfo endpoint.
    if (!email && sub && accessToken) {
      try {
        const info = (await oidc.fetchUserInfo(config, accessToken, sub)) as Record<string, unknown>;
        email = (info.email as string | undefined)?.toLowerCase();
      } catch {
        /* ignore — handled below */
      }
    }
    if (!sub || !email) return reply.redirect(`${base()}/?sso_error=no_email`);

    if (o.allowedDomain && email.split('@')[1] !== o.allowedDomain) {
      recordAudit({ actorId: null, action: 'sso_denied_domain', targetType: 'user', payload: { email }, status: 403 });
      return reply.redirect(`${base()}/?sso_error=domain`);
    }

    // Resolve: by stable subject → by email (link) → JIT-create (domain already checked).
    let user = (await db.select().from(schema.users).where(eq(schema.users.oidcSubject, sub)).limit(1))[0];
    if (!user) {
      const byEmail = (await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1))[0];
      if (byEmail) {
        await db.update(schema.users).set({ oidcSubject: sub }).where(eq(schema.users.id, byEmail.id));
        user = byEmail;
      }
    }
    if (!user) {
      // Provisioning a brand-new account via SSO requires an invite — the SAME gate as
      // password signup (routes.ts). SSO is a sign-in method, not an open door: existing/
      // linked users resolved above never need a code; only first-time creation does.
      // The optional allowedDomain check above still applies as an extra filter.
      const code = saved.invite?.trim();
      if (!code) {
        recordAudit({ actorId: null, action: 'sso_denied_no_invite', targetType: 'user', payload: { email }, status: 403 });
        return reply.redirect(`${base()}/?sso_error=invite_required`);
      }
      // Atomically consume the invite: only succeeds if it exists, has uses left, and is not
      // expired. The conditional UPDATE makes concurrent reuse safe (mirrors signup).
      const now = new Date();
      const consumed = await db
        .update(schema.invites)
        .set({ usedCount: sql`${schema.invites.usedCount} + 1` })
        .where(
          and(
            eq(schema.invites.code, code),
            lt(schema.invites.usedCount, schema.invites.maxUses),
            or(isNull(schema.invites.expiresAt), gt(schema.invites.expiresAt, now)),
          ),
        )
        .returning({ code: schema.invites.code });
      if (!consumed.length) {
        recordAudit({ actorId: null, action: 'sso_denied_invite', targetType: 'user', payload: { email, reason: 'invalid_or_exhausted' }, status: 403 });
        return reply.redirect(`${base()}/?sso_error=invite_invalid`);
      }

      const id = nanoid();
      await db.insert(schema.users).values({ id, email, oidcSubject: sub, passwordHash: null });
      await seedUser(id);
      recordAudit({ actorId: id, action: 'sso_provisioned', targetType: 'user', targetId: id, payload: { email, via: 'invite' }, status: 201 });
      user = (await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1))[0];
    }

    if (user.deactivatedAt) {
      recordAudit({ actorId: null, action: 'login_deactivated', targetType: 'user', targetId: user.id, payload: { email, via: 'sso' }, status: 403 });
      return reply.redirect(`${base()}/?sso_error=deactivated`);
    }

    const sessionId = await createSession(user.id);
    setSessionCookie(req, reply, sessionId);
    recordAudit({ actorId: user.id, action: 'sso_login', targetType: 'user', targetId: user.id, status: 200 });
    return reply.redirect(`${base()}/`);
  });
}
