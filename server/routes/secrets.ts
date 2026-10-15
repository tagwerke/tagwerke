// Board secrets + one-time secret links (SECRET_LINKS_PLAN.md, reshaped 2026-10-14 to "boards with
// secrets": the vault belongs to a board, not to a person).
//
// Two halves with deliberately different crypto (D5):
//
//   • Board entries — encrypted HERE under VAULT_KEY (server/lib/vault.ts). Board ADMINS only, and
//     only from inside the board's network policy; anything that reveals or changes a value also
//     needs a fresh step-up (/api/auth/sudo). A stolen session cookie alone is not enough.
//   • Secret links — zero-knowledge (D1). The browser encrypts, the key lives in the URL fragment,
//     this server only ever stores ciphertext. Burned on first read by one atomic update (D3) behind
//     a POST, never a GET (D2), with an identical answer for missing/burned/expired (§3).
//
// Never logged, by anyone, anywhere: a secret value, notes, a link's ciphertext or fragment, or a
// link's label. Every handler here writes its own audit row, and the generic body-logging hook is
// switched off for the whole plugin (onRequest below) — so a 400 on a body carrying a password
// cannot land that password in audit_log.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db, pool, schema } from '../db/client.ts';
import { requireAuth } from '../auth/guard.ts';
import { boardRole, roleAtLeast } from '../auth/boards.ts';
import { sudoActive } from '../auth/session.ts';
import { recordAudit } from '../lib/audit.ts';
import { vaultStatus, seal, sealOpt, open, openOpt, entryAad, VaultUnavailable } from '../lib/vault.ts';
import { formatCidr, ipInCidrs, normalizeIp, parseCidr, withinPin } from '../lib/ipnet.ts';

const READ_RL = { max: 60, timeWindow: '1 minute' } as const;
const WRITE_RL = { max: 30, timeWindow: '1 minute' } as const;
const REVEAL_RL = { max: 30, timeWindow: '1 minute' } as const;
// The unauthenticated burn. Per IP; an id is 126 random bits, so this is about stopping a scanner
// from burning links by brute force, not about guessing.
const PUBLIC_REVEAL_RL = { max: 10, timeWindow: '1 minute' } as const;

const MAX_LINK_TTL_S = 7 * 24 * 60 * 60;
const MIN_LINK_TTL_S = 5 * 60;
// base64url of iv ‖ ciphertext ‖ tag for a ~48 KB plaintext. Generous for credentials, small enough
// that the table cannot be used as free file storage.
const MAX_CIPHERTEXT_CHARS = 65_536;

/** The one answer for every failed public reveal — never existed, already read, expired, revoked. */
const GONE = { error: 'not available' } as const;

// ---- guard -----------------------------------------------------------------

type BoardOf = (req: FastifyRequest) => Promise<string | undefined> | string | undefined;

const paramBoard: BoardOf = (req) => (req.params as { id: string }).id;

const entryBoard: BoardOf = async (req) => {
  const { id } = req.params as { id: string };
  const [row] = await db
    .select({ tabId: schema.secretEntries.tabId })
    .from(schema.secretEntries)
    .where(eq(schema.secretEntries.id, id))
    .limit(1);
  return row?.tabId;
};

function clientIp(req: FastifyRequest): string {
  return normalizeIp(req.ip ?? '');
}

async function boardCidrs(tabId: string): Promise<string[]> {
  const [row] = await db
    .select({ allowedCidrs: schema.secretPolicies.allowedCidrs })
    .from(schema.secretPolicies)
    .where(eq(schema.secretPolicies.tabId, tabId))
    .limit(1);
  return Array.isArray(row?.allowedCidrs) ? (row.allowedCidrs as string[]) : [];
}

/**
 * One preHandler, every check, in order — written as a single function rather than a chain so no
 * check can be skipped by a reply that a later hook fails to notice.
 *
 *   member? (404, so a board you are not on is not probeable) → admin? (403) → vault on? (503)
 *   → inside the board's network policy? (403 ip_not_allowed) → fresh step-up? (401 sudo required)
 */
function guardSecrets(boardOf: BoardOf, opts: { sudo: boolean }) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
    const userId = req.user?.id;
    if (!userId) return reply.code(401).send({ error: 'unauthenticated' });
    const tabId = await boardOf(req);
    if (!tabId) return reply.code(404).send({ error: 'not found' });
    const role = await boardRole(userId, tabId);
    if (!role) return reply.code(404).send({ error: 'not found' });
    req.boardScope = tabId;
    if (!roleAtLeast(role, 'admin')) return reply.code(403).send({ error: 'only board admins can use secrets' });

    const vault = vaultStatus();
    if (!vault.ok) return reply.code(503).send({ error: 'secrets are not enabled on this instance', code: 'vault_off' });

    const cidrs = await boardCidrs(tabId);
    const ip = clientIp(req);
    if (cidrs.length && !ipInCidrs(ip, cidrs)) {
      recordAudit({
        actorId: userId, action: 'secret_access_denied_ip', targetType: 'tab', targetId: tabId,
        scopeId: tabId, method: req.method, status: 403, payload: { ip },
      });
      return reply.code(403).send({ error: 'secrets on this board are restricted to approved networks', code: 'ip_not_allowed', ip });
    }

    if (opts.sudo && !(await sudoActive(req))) return reply.code(401).send({ error: 'sudo required' });
  };
}

// ---- entries ---------------------------------------------------------------

type EntryRow = typeof schema.secretEntries.$inferSelect;

/** Matches `SecretEntryDTO` in src/types.ts. Never carries the secret or the notes. */
function entryDTO(r: EntryRow): Record<string, unknown> {
  return {
    id: r.id,
    tabId: r.tabId,
    name: r.name,
    username: openOpt(r.usernameEnc, entryAad(r.tabId, r.id, 'username')) ?? undefined,
    url: openOpt(r.urlEnc, entryAad(r.tabId, r.id, 'url')) ?? undefined,
    hasNotes: r.notesEnc != null,
    createdBy: r.createdBy ?? undefined,
    updatedBy: r.updatedBy ?? undefined,
    createdAt: r.createdAt.getTime(),
    updatedAt: r.updatedAt.getTime(),
  };
}

const optText = (max: number) => z.string().max(max).nullable().optional();

const createBody = z.object({
  name: z.string().trim().min(1).max(200),
  username: optText(500),
  secret: z.string().min(1).max(10_000),
  url: optText(2_000),
  notes: optText(20_000),
});

const patchBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  username: optText(500),
  secret: z.string().min(1).max(10_000).optional(),
  url: optText(2_000),
  notes: optText(20_000),
});

const policyBody = z.object({ allowedCidrs: z.array(z.string().max(64)).max(50) });

/** A decrypt failure is an operator problem (wrong or missing key), never the caller's. */
function vaultError(req: FastifyRequest, reply: FastifyReply, err: unknown): FastifyReply {
  req.log.error({ err: err instanceof Error ? err.message : String(err) }, 'secret could not be decrypted');
  const detail = err instanceof VaultUnavailable ? err.message : 'decryption failed — is VAULT_KEY the key these were stored with?';
  return reply.code(500).send({ error: `secret could not be decrypted: ${detail}` });
}

export async function secretRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (req) => {
    req.auditHandled = true;
  });
  app.addHook('preHandler', requireAuth);
  app.addHook('onSend', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
  });

  // ---- list: names, usernames, URLs — never values --------------------------
  app.get(
    '/api/boards/:id/secrets',
    { preHandler: guardSecrets(paramBoard, { sudo: false }), config: { rateLimit: READ_RL } },
    async (req, reply) => {
      const tabId = req.boardScope!;
      const rows = await db
        .select()
        .from(schema.secretEntries)
        .where(eq(schema.secretEntries.tabId, tabId))
        .orderBy(schema.secretEntries.name);
      let entries;
      try {
        entries = rows.map(entryDTO);
      } catch (err) {
        return vaultError(req, reply, err);
      }
      return {
        entries,
        policy: { allowedCidrs: await boardCidrs(tabId) },
        clientIp: clientIp(req),
        sudo: await sudoActive(req),
      };
    },
  );

  // ---- create ----------------------------------------------------------------
  app.post(
    '/api/boards/:id/secrets',
    { preHandler: guardSecrets(paramBoard, { sudo: true }), config: { rateLimit: WRITE_RL } },
    async (req, reply) => {
      const b = createBody.safeParse(req.body);
      if (!b.success) return reply.code(400).send({ error: 'invalid secret' });
      const tabId = req.boardScope!;
      const userId = req.user!.id;
      const id = nanoid();
      const [row] = await db
        .insert(schema.secretEntries)
        .values({
          id,
          tabId,
          name: b.data.name,
          usernameEnc: sealOpt(b.data.username, entryAad(tabId, id, 'username')),
          secretEnc: seal(b.data.secret, entryAad(tabId, id, 'secret')),
          urlEnc: sealOpt(b.data.url, entryAad(tabId, id, 'url')),
          notesEnc: sealOpt(b.data.notes, entryAad(tabId, id, 'notes')),
          createdBy: userId,
          updatedBy: userId,
        })
        .returning();
      recordAudit({
        actorId: userId, action: 'secret_create', targetType: 'secret_entry', targetId: id,
        scopeId: tabId, method: 'POST', status: 200,
      });
      return entryDTO(row);
    },
  );

  // ---- reveal: the only way to a value -----------------------------------------
  // POST so nothing prefetches, caches or replays it as a harmless read.
  app.post(
    '/api/secrets/:id/reveal',
    { preHandler: guardSecrets(entryBoard, { sudo: true }), config: { rateLimit: REVEAL_RL } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const [r] = await db.select().from(schema.secretEntries).where(eq(schema.secretEntries.id, id)).limit(1);
      if (!r) return reply.code(404).send({ error: 'not found' });
      let out;
      try {
        out = {
          secret: open(r.secretEnc, entryAad(r.tabId, r.id, 'secret')),
          notes: openOpt(r.notesEnc, entryAad(r.tabId, r.id, 'notes')) ?? undefined,
        };
      } catch (err) {
        return vaultError(req, reply, err);
      }
      recordAudit({
        actorId: req.user!.id, action: 'secret_reveal', targetType: 'secret_entry', targetId: id,
        scopeId: r.tabId, method: 'POST', status: 200, payload: { ip: clientIp(req) },
      });
      return out;
    },
  );

  // ---- edit ------------------------------------------------------------------
  app.patch(
    '/api/secrets/:id',
    { preHandler: guardSecrets(entryBoard, { sudo: true }), config: { rateLimit: WRITE_RL } },
    async (req, reply) => {
      const b = patchBody.safeParse(req.body);
      if (!b.success) return reply.code(400).send({ error: 'invalid secret' });
      const { id } = req.params as { id: string };
      const tabId = req.boardScope!;
      const userId = req.user!.id;
      const p = b.data;

      const set: Partial<typeof schema.secretEntries.$inferInsert> = { updatedBy: userId, updatedAt: new Date() };
      if (p.name !== undefined) set.name = p.name;
      if (p.username !== undefined) set.usernameEnc = sealOpt(p.username, entryAad(tabId, id, 'username'));
      if (p.secret !== undefined) set.secretEnc = seal(p.secret, entryAad(tabId, id, 'secret'));
      if (p.url !== undefined) set.urlEnc = sealOpt(p.url, entryAad(tabId, id, 'url'));
      if (p.notes !== undefined) set.notesEnc = sealOpt(p.notes, entryAad(tabId, id, 'notes'));

      const [row] = await db.update(schema.secretEntries).set(set).where(eq(schema.secretEntries.id, id)).returning();
      if (!row) return reply.code(404).send({ error: 'not found' });
      // Which fields changed, never what they changed from or to.
      const fields = (['name', 'username', 'secret', 'url', 'notes'] as const).filter((f) => p[f] !== undefined);
      recordAudit({
        actorId: userId, action: 'secret_update', targetType: 'secret_entry', targetId: id,
        scopeId: tabId, method: 'PATCH', status: 200, payload: { fields },
      });
      return entryDTO(row);
    },
  );

  // ---- delete (hard) ---------------------------------------------------------
  app.delete(
    '/api/secrets/:id',
    { preHandler: guardSecrets(entryBoard, { sudo: true }), config: { rateLimit: WRITE_RL } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const tabId = req.boardScope!;
      const [row] = await db.delete(schema.secretEntries).where(eq(schema.secretEntries.id, id)).returning({ id: schema.secretEntries.id });
      if (!row) return reply.code(404).send({ error: 'not found' });
      recordAudit({
        actorId: req.user!.id, action: 'secret_delete', targetType: 'secret_entry', targetId: id,
        scopeId: tabId, method: 'DELETE', status: 200,
      });
      return { ok: true };
    },
  );

  // ---- network policy --------------------------------------------------------
  app.put(
    '/api/boards/:id/secret-policy',
    { preHandler: guardSecrets(paramBoard, { sudo: true }), config: { rateLimit: WRITE_RL } },
    async (req, reply) => {
      const b = policyBody.safeParse(req.body);
      if (!b.success) return reply.code(400).send({ error: 'invalid policy' });
      const tabId = req.boardScope!;
      const userId = req.user!.id;

      const cidrs: string[] = [];
      for (const raw of b.data.allowedCidrs.map((s) => s.trim()).filter(Boolean)) {
        const c = parseCidr(raw);
        if (!c) return reply.code(400).send({ error: `not an IP address or CIDR range: ${raw}` });
        const s = formatCidr(c);
        if (!cidrs.includes(s)) cidrs.push(s);
      }
      // Saving a list that excludes the address you are saving it from would lock you out on the
      // very next request, with no way back short of another admin or the database.
      const ip = clientIp(req);
      if (cidrs.length && !ipInCidrs(ip, cidrs)) {
        return reply.code(400).send({ error: `your current address (${ip}) is not in this list — saving it would lock you out` });
      }

      await db
        .insert(schema.secretPolicies)
        .values({ tabId, allowedCidrs: cidrs, updatedBy: userId, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: schema.secretPolicies.tabId,
          set: { allowedCidrs: cidrs, updatedBy: userId, updatedAt: new Date() },
        });
      recordAudit({
        actorId: userId, action: 'secret_policy_change', targetType: 'tab', targetId: tabId,
        scopeId: tabId, method: 'PUT', status: 200, payload: { allowedCidrs: cidrs },
      });
      return { allowedCidrs: cidrs };
    },
  );

  // ---- secret links (sender side) --------------------------------------------

  const linkBody = z.object({
    ciphertext: z.string().min(16).max(MAX_CIPHERTEXT_CHARS).regex(/^[A-Za-z0-9_-]+$/),
    ttlSeconds: z.number().int().min(MIN_LINK_TTL_S).max(MAX_LINK_TTL_S),
    pinPrefix: z.union([z.literal(32), z.literal(24)]).optional(),
    label: z.string().trim().max(200).optional(),
    tabId: z.string().max(64).optional(),
    entryId: z.string().max(64).optional(),
  });

  app.post('/api/secret-links', { config: { rateLimit: WRITE_RL } }, async (req, reply) => {
    const b = linkBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'invalid link' });
    const userId = req.user!.id;
    const { tabId, entryId } = b.data;
    // Filing a link under a board is an admin act on that board: its Secrets view lists it.
    if (tabId) {
      const role = await boardRole(userId, tabId);
      if (!role) return reply.code(404).send({ error: 'not found' });
      if (!roleAtLeast(role, 'admin')) return reply.code(403).send({ error: 'only board admins can use secrets' });
    }
    const id = nanoid(); // 126 bits: the id is not the secret, but it must not be guessable either
    const expiresAt = new Date(Date.now() + b.data.ttlSeconds * 1000);
    await db.insert(schema.secretLinks).values({
      id,
      ciphertext: b.data.ciphertext,
      createdBy: userId,
      tabId: tabId ?? null,
      expiresAt,
      pinPrefix: b.data.pinPrefix ?? 32,
      label: b.data.label || null,
    });
    recordAudit({
      actorId: userId, action: 'secret_link_create', targetType: 'secret_link', targetId: id,
      scopeId: tabId ?? null, method: 'POST', status: 200,
      payload: { ttlSeconds: b.data.ttlSeconds, pinPrefix: b.data.pinPrefix ?? 32, entryId: entryId ?? null },
    });
    return { id, expiresAt: expiresAt.getTime() };
  });

  // The sender's own links. Never the ciphertext.
  app.get('/api/secret-links', { config: { rateLimit: READ_RL } }, async (req) => {
    const { tabId } = req.query as { tabId?: string };
    const where = [eq(schema.secretLinks.createdBy, req.user!.id)];
    if (tabId) where.push(eq(schema.secretLinks.tabId, tabId));
    const rows = await db
      .select({
        id: schema.secretLinks.id,
        label: schema.secretLinks.label,
        tabId: schema.secretLinks.tabId,
        createdAt: schema.secretLinks.createdAt,
        expiresAt: schema.secretLinks.expiresAt,
        viewedAt: schema.secretLinks.viewedAt,
        foreignAttemptAt: schema.secretLinks.foreignAttemptAt,
      })
      .from(schema.secretLinks)
      .where(and(...where))
      .orderBy(desc(schema.secretLinks.createdAt))
      .limit(100);
    const now = Date.now();
    return {
      links: rows.map((r) => ({
        id: r.id,
        label: r.label ?? undefined,
        tabId: r.tabId ?? undefined,
        createdAt: r.createdAt.getTime(),
        expiresAt: r.expiresAt.getTime(),
        viewedAt: r.viewedAt?.getTime(),
        foreignAttemptAt: r.foreignAttemptAt?.getTime(),
        status: r.viewedAt ? 'opened' : r.expiresAt.getTime() <= now ? 'expired' : 'waiting',
      })),
    };
  });

  app.delete('/api/secret-links/:id', { config: { rateLimit: WRITE_RL } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const userId = req.user!.id;
    const [row] = await db
      .delete(schema.secretLinks)
      .where(and(eq(schema.secretLinks.id, id), eq(schema.secretLinks.createdBy, userId)))
      .returning({ tabId: schema.secretLinks.tabId });
    if (!row) return reply.code(404).send({ error: 'not found' });
    recordAudit({
      actorId: userId, action: 'secret_link_revoke', targetType: 'secret_link', targetId: id,
      scopeId: row.tabId ?? null, method: 'DELETE', status: 200,
    });
    return { ok: true };
  });
}

// ---- secret links (recipient side, PUBLIC) ------------------------------------

/**
 * The unauthenticated half. Its own plugin so the session hook above can never be applied to it by
 * accident, and so nothing here can see a session even if the recipient happens to have one.
 */
export async function publicSecretRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (req) => {
    req.auditHandled = true;
  });
  app.addHook('onSend', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-robots-tag', 'noindex, nofollow');
  });

  app.post(
    '/api/public/secret-links/:id/reveal',
    { config: { rateLimit: PUBLIC_REVEAL_RL } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!/^[A-Za-z0-9_-]{10,64}$/.test(id)) return reply.code(404).send(GONE);
      const ip = clientIp(req);
      const ipParam = ip && /^[0-9a-fA-F:.]+$/.test(ip) ? ip : null;

      // D3: one atomic conditional update — no read-then-write. The row lock in `target` makes a
      // concurrent second request re-check `viewed_at IS NULL` after the first commits, so exactly
      // one caller ever gets the payload. The ciphertext is blanked in the same statement, so a
      // read link holds nothing worth stealing from a later dump.
      const { rows } = await pool.query<{ ciphertext: string; created_by: string | null; tab_id: string | null }>(
        `WITH target AS (
           SELECT id, ciphertext FROM secret_links
            WHERE id = $1 AND viewed_at IS NULL AND expires_at > now()
            FOR UPDATE
         )
         UPDATE secret_links s
            SET viewed_at = now(), viewed_ip = $2::inet, ciphertext = ''
           FROM target
          WHERE s.id = target.id
        RETURNING target.ciphertext, s.created_by, s.tab_id`,
        [id, ipParam],
      );
      const hit = rows[0];
      if (hit) {
        recordAudit({
          actorId: null, action: 'secret_link_reveal', targetType: 'secret_link', targetId: id,
          scopeId: hit.tab_id, method: 'POST', status: 200, payload: { ip: ipParam, sender: hit.created_by },
        });
        return { ciphertext: hit.ciphertext };
      }

      // Failed. Same answer whatever the reason (§3) — but an attempt on an already-read link from
      // outside the reader's network is the leaked-in-transit signal (D4), so the sender hears of it.
      const [row] = await db
        .select({
          viewedAt: schema.secretLinks.viewedAt,
          viewedIp: schema.secretLinks.viewedIp,
          pinPrefix: schema.secretLinks.pinPrefix,
          createdBy: schema.secretLinks.createdBy,
          tabId: schema.secretLinks.tabId,
        })
        .from(schema.secretLinks)
        .where(eq(schema.secretLinks.id, id))
        .limit(1);
      if (row?.viewedAt && row.viewedIp && ipParam && !withinPin(ipParam, row.viewedIp, row.pinPrefix)) {
        await db.update(schema.secretLinks).set({ foreignAttemptAt: new Date() }).where(eq(schema.secretLinks.id, id));
        recordAudit({
          actorId: null, action: 'secret_link_refused', targetType: 'secret_link', targetId: id,
          scopeId: row.tabId, method: 'POST', status: 404, payload: { ip: ipParam, sender: row.createdBy },
        });
      }
      return reply.code(404).send(GONE);
    },
  );
}
