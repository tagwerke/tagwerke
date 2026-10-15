// Secret-link expiry sweep (SECRET_LINKS_PLAN §4 P2). Same shape as jobs/sprints.ts: an hourly,
// idempotent tick.
//
// Two steps, because they protect different things:
//   1. An expired, never-read link has its ciphertext blanked at once. Expired means nobody may read
//      it, so there is no reason to keep holding it — the burn blanks a READ link the same way.
//   2. The row itself is kept for a while so the sender's list can still say "expired, never
//      opened", then deleted.

import type { FastifyBaseLogger } from 'fastify';
import { pool } from '../db/client.ts';

const INTERVAL_MS = 60 * 60 * 1000; // hourly
const KEEP_DAYS = 30;

let running = false;

async function tick(log: FastifyBaseLogger): Promise<void> {
  if (running) return;
  running = true;
  try {
    const blanked = await pool.query(
      `UPDATE secret_links SET ciphertext = '' WHERE expires_at <= now() AND ciphertext <> ''`,
    );
    const deleted = await pool.query(
      `DELETE FROM secret_links WHERE expires_at < now() - make_interval(days => $1)`,
      [KEEP_DAYS],
    );
    if (blanked.rowCount || deleted.rowCount) {
      log.info({ blanked: blanked.rowCount, deleted: deleted.rowCount }, 'secret-link sweep');
    }
  } catch (err) {
    log.error({ err }, 'secret-link sweep failed — will retry next tick');
  } finally {
    running = false;
  }
}

/** Start the hourly sweep. unref: never holds the process open. */
export function startSecretLinkSweep(log: FastifyBaseLogger): void {
  setTimeout(() => void tick(log), 60_000).unref();
  setInterval(() => void tick(log), INTERVAL_MS).unref();
}
