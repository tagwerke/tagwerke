// Automatic backups — included, not opt-in. The server dumps its own database
// daily into BACKUP_DIR (default ./backups, bind-mounted to the host in the
// compose stack), so a fresh install is backed up from day one with zero setup.
//
// Same artifacts and naming as scripts/backup.sh: a full `pg_dump -Fc` of every
// table (tagwerke-<UTC>.dump, or .dump.age when BACKUP_AGE_RECIPIENT is set —
// piped through age, plaintext never touches disk) plus a row-counts manifest
// (tagwerke-<UTC>.counts.json) that scripts/restore-drill.sh verifies against.
//
// What this deliberately does NOT do: upload anything, anywhere. Off-site copies
// and restore drills remain the operator's responsibility — see
// docs/self-hosting.md "Backup & restore".
//
// Opt-out (operators with their own pgBackRest/snapshot pipeline):
// BACKUP_DISABLED=true — logged loudly on every boot so it can't be forgotten.

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { pool } from '../db/client.ts';

const BACKUP_DIR = process.env.BACKUP_DIR ?? 'backups';
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP ?? 14));
const AGE_RECIPIENT = process.env.BACKUP_AGE_RECIPIENT ?? '';
const INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const CHECK_MS = 60 * 60 * 1000; // staleness check every hour

let running = false;

/** `pg_dump --version` / `age --version` — is the binary reachable? */
async function binAvailable(bin: string): Promise<boolean> {
  try {
    const p = spawn(bin, ['--version'], { stdio: 'ignore' });
    const [code] = (await once(p, 'close')) as [number];
    return code === 0;
  } catch {
    return false;
  }
}

/** Newest dump's mtime in BACKUP_DIR, or null if there are none. */
async function newestDumpAt(): Promise<Date | null> {
  let names: string[];
  try {
    names = await readdir(BACKUP_DIR);
  } catch {
    return null; // dir doesn't exist yet
  }
  let newest: Date | null = null;
  for (const n of names) {
    if (!/^tagwerke-.*\.dump(\.age)?$/.test(n)) continue;
    const s = await stat(path.join(BACKUP_DIR, n));
    if (!newest || s.mtime > newest) newest = s.mtime;
  }
  return newest;
}

/** Row count per public table + applied-migrations count, for the drill to verify. */
async function countsManifest(stamp: string): Promise<string> {
  const tables = await pool.query(
    "select tablename from pg_tables where schemaname='public' order by tablename",
  );
  const migrations = await pool.query('select count(*) from drizzle.__drizzle_migrations');
  const lines: string[] = [];
  for (const { tablename } of tables.rows as { tablename: string }[]) {
    const c = await pool.query(`select count(*) from public."${tablename}"`);
    lines.push(`    "${tablename}": ${c.rows[0].count}`);
  }
  const db = await pool.query('select current_database()');
  return [
    '{',
    `  "generated_at": "${stamp}",`,
    `  "database": "${db.rows[0].current_database}",`,
    `  "migrations": ${migrations.rows[0].count},`,
    '  "tables": {',
    lines.join(',\n'),
    '  }',
    '}',
    '',
  ].join('\n');
}

/** Take one full backup. Throws on failure — callers log, never crash the app. */
export async function runBackup(log: FastifyBaseLogger): Promise<string> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  await mkdir(BACKUP_DIR, { recursive: true });

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
  const base = path.join(BACKUP_DIR, `tagwerke-${stamp}`);
  await writeFile(`${base}.counts.json`, await countsManifest(stamp));

  const out = AGE_RECIPIENT ? `${base}.dump.age` : `${base}.dump`;
  const dump = spawn('pg_dump', ['-Fc', url], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  dump.stderr.on('data', (d) => (stderr += d));

  const sink = createWriteStream(out);
  let encrypt: ReturnType<typeof spawn> | null = null;
  if (AGE_RECIPIENT) {
    encrypt = spawn('age', ['-r', AGE_RECIPIENT], { stdio: ['pipe', 'pipe', 'pipe'] });
    encrypt.stderr!.on('data', (d) => (stderr += d));
    dump.stdout.pipe(encrypt.stdin!);
    encrypt.stdout!.pipe(sink);
  } else {
    dump.stdout.pipe(sink);
  }

  const codes = await Promise.all([
    once(dump, 'close').then(([c]) => c as number),
    encrypt ? once(encrypt, 'close').then(([c]) => c as number) : 0,
    once(sink, 'close').then(() => 0),
  ]);
  if (codes.some((c) => c !== 0)) {
    await rm(out, { force: true });
    await rm(`${base}.counts.json`, { force: true });
    throw new Error(`backup failed: ${stderr.trim() || `exit codes ${codes.join(',')}`}`);
  }

  const size = (await stat(out)).size;
  if (size === 0) {
    await rm(out, { force: true });
    await rm(`${base}.counts.json`, { force: true });
    throw new Error('backup failed: dump is empty');
  }

  await prune(log);
  log.info({ file: out, bytes: size }, 'automatic backup written');
  return out;
}

/** Keep the newest KEEP dumps (+ their manifests), delete the rest. */
async function prune(log: FastifyBaseLogger): Promise<void> {
  const names = (await readdir(BACKUP_DIR)).filter((n) =>
    /^tagwerke-.*\.dump(\.age)?$/.test(n),
  );
  const dated = await Promise.all(
    names.map(async (n) => ({ n, mtime: (await stat(path.join(BACKUP_DIR, n))).mtime })),
  );
  dated.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  for (const { n } of dated.slice(KEEP)) {
    await rm(path.join(BACKUP_DIR, n), { force: true });
    await rm(path.join(BACKUP_DIR, n.replace(/\.dump(\.age)?$/, '.counts.json')), {
      force: true,
    });
    log.info({ file: n }, 'pruned old backup');
  }
}

/**
 * Start the automatic-backup loop: hourly, take a backup if the newest one is
 * older than a day (also covers instances that are only powered on sometimes).
 * Failures are logged as errors and retried on the next tick — never fatal.
 */
export async function startBackupScheduler(log: FastifyBaseLogger): Promise<void> {
  if (process.env.BACKUP_DISABLED === 'true') {
    log.warn(
      'AUTOMATIC BACKUPS ARE DISABLED (BACKUP_DISABLED=true) — you are responsible for your own backups',
    );
    return;
  }
  if (!(await binAvailable('pg_dump'))) {
    log.error(
      'automatic backups unavailable: pg_dump not found — install postgresql-client 16+, or use scripts/backup.sh externally',
    );
    return;
  }
  if (AGE_RECIPIENT && !(await binAvailable('age'))) {
    log.error(
      'automatic backups unavailable: BACKUP_AGE_RECIPIENT is set but age is not installed',
    );
    return;
  }

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const newest = await newestDumpAt();
      if (!newest || Date.now() - newest.getTime() >= INTERVAL_MS) {
        await runBackup(log);
      }
    } catch (err) {
      log.error({ err }, 'automatic backup failed — will retry within the hour');
    } finally {
      running = false;
    }
  };

  // First check shortly after boot (fresh installs get their first backup right
  // away), then hourly. unref: don't hold the process open on shutdown.
  setTimeout(tick, 30_000).unref();
  setInterval(tick, CHECK_MS).unref();
  log.info({ dir: BACKUP_DIR, keep: KEEP, encrypted: Boolean(AGE_RECIPIENT) }, 'automatic daily backups on');
}
