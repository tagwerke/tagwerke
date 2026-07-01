import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool, schema } from './db/client.ts';
import { authRoutes } from './auth/routes.ts';
import { oidcRoutes } from './auth/oidc.ts';
import { passkeyRoutes } from './auth/webauthn.ts';
import { stateRoutes } from './routes/state.ts';
import { projectRoutes } from './routes/projects.ts';
import { tabRoutes } from './routes/tabs.ts';
import { taskRoutes } from './routes/tasks.ts';
import { timeBlockRoutes } from './routes/timeBlocks.ts';
import { memberRoutes } from './routes/members.ts';
import { eventRoutes } from './routes/events.ts';
import { adminRoutes } from './routes/admin.ts';
import { auditRoutes } from './routes/audit.ts';
import { sudoRoutes } from './routes/sudo.ts';
import { orgRoutes, ORG_ID } from './routes/org.ts';
import { activityRoutes } from './routes/activity.ts';
import { registerAuditHook } from './lib/audit.ts';

const PORT = Number(process.env.PORT ?? 5174);
// Bind all interfaces by default so the container is reachable; override with HOST.
const HOST = process.env.HOST ?? '0.0.0.0';
const isProd = process.env.NODE_ENV === 'production';

const secret = process.env.SESSION_SECRET;
if (!secret) throw new Error('SESSION_SECRET is not set.');

// trustProxy: behind Dokploy/Traefik, derive client IP + protocol from
// X-Forwarded-* so rate-limiting keys on the real IP and cookies behave.
const app = Fastify({ logger: true, trustProxy: true });

// Apply pending migrations before serving. Idempotent; safe to run each boot.
try {
  const migrationsFolder = fileURLToPath(new URL('./db/migrations', import.meta.url));
  await migrate(db, { migrationsFolder });
  app.log.info('migrations up to date');
} catch (err) {
  app.log.error({ err }, 'migration failed');
  process.exit(1);
}

// Seed the singleton org row (org IS the instance). Idempotent: the fixed PK means a
// second boot is a no-op. Name comes from ORG_NAME, defaulting to 'Workspace'.
await db
  .insert(schema.org)
  .values({ id: ORG_ID, name: process.env.ORG_NAME ?? 'Workspace' })
  .onConflictDoNothing();

await app.register(cookie, { secret });

// Append-only audit trail over every mutating /api request (coarse for content edits,
// full for structural; security events self-enrich in their handlers). Registered once.
registerAuditHook(app);
// global:false -> only routes that opt in (auth endpoints) are limited, so heavy
// authenticated editing traffic is never throttled.
await app.register(rateLimit, { global: false });

// Liveness/readiness probe for container healthchecks. Unauthenticated, no rate
// limit; verifies the DB is reachable so an unhealthy instance can be restarted.
app.get('/health', async (_req, reply) => {
  try {
    await pool.query('select 1');
    return { ok: true };
  } catch {
    return reply.code(503).send({ ok: false, error: 'database unreachable' });
  }
});

await app.register(authRoutes);
await app.register(oidcRoutes);
await app.register(passkeyRoutes);
await app.register(stateRoutes);
await app.register(projectRoutes);
await app.register(tabRoutes);
await app.register(taskRoutes);
await app.register(timeBlockRoutes);
await app.register(memberRoutes);
await app.register(eventRoutes);
await app.register(sudoRoutes);
await app.register(adminRoutes);
await app.register(auditRoutes);
await app.register(orgRoutes);
await app.register(activityRoutes);

// In production the same process serves the built SPA. In dev, Vite serves it.
if (isProd) {
  const distDir = fileURLToPath(new URL('../dist', import.meta.url));
  if (!existsSync(distDir)) {
    app.log.error(`dist/ not found at ${distDir} — run "npm run build" before starting`);
    process.exit(1);
  }
  await app.register(fastifyStatic, { root: distDir });
  // SPA fallback: any non-API GET that isn't a real file returns index.html.
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api')) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not found' });
  });
}

try {
  await app.listen({ port: PORT, host: HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
