import 'dotenv/config';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { authRoutes } from './auth/routes.ts';
import { stateRoutes } from './routes/state.ts';
import { projectRoutes } from './routes/projects.ts';
import { tabRoutes } from './routes/tabs.ts';
import { taskRoutes } from './routes/tasks.ts';
import { blockRoutes } from './routes/blocks.ts';
import { todayRoutes } from './routes/today.ts';

const PORT = Number(process.env.PORT ?? 5174);
const HOST = process.env.HOST ?? '127.0.0.1';

const secret = process.env.SESSION_SECRET;
if (!secret) throw new Error('SESSION_SECRET is not set. Copy .env.example to .env and fill it in.');

const app = Fastify({ logger: true });

await app.register(cookie, { secret });
// global:false -> only routes that opt in (auth endpoints) are limited, so heavy
// authenticated editing traffic is never throttled.
await app.register(rateLimit, { global: false });

await app.register(authRoutes);
await app.register(stateRoutes);
await app.register(projectRoutes);
await app.register(tabRoutes);
await app.register(taskRoutes);
await app.register(blockRoutes);
await app.register(todayRoutes);

try {
  await app.listen({ port: PORT, host: HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
