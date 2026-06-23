// Shared connection helper for the one-off DB scripts in this folder. Each script
// otherwise re-opened a raw pg client with the same keep-alive setup; this centralizes
// it. (Scripts that need Drizzle use `../db/client.ts` instead.)

import 'dotenv/config';
import pg from 'pg';

/**
 * Open a connected raw pg client for a one-off script. Keep-alive on (a long single
 * connection survives TCP poolers like PgBouncer/Traefik); opt-in lax TLS via
 * PGSSL=require for hosted PGs with self-signed certs. The caller must `await
 * client.end()` when done.
 */
export async function connect(): Promise<pg.Client> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set.');
  const client = new pg.Client({
    connectionString,
    keepAlive: true,
    ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  return client;
}
