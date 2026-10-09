// Read-only recovery for a task description that vanished. `description` is an AUDITED_FIELD
// (routes/tasks.ts), so every write to it appends an audit_log row carrying the FULL before/after
// text — untruncated, since diffChanges() stores the raw values (lib/audit.ts). A description that
// was cleared or overwritten is therefore still on disk in `payload.changes[].from`, even though
// the task row itself no longer shows it.
//
// Usage:
//   tsx server/scripts/recover-description.ts                 # list every description change, newest first
//   tsx server/scripts/recover-description.ts <taskId>        # print that task's recoverable text in full
//
// Purely SELECTs — writes nothing. Point it at another instance with DATABASE_URL=... in front.

import 'dotenv/config';
import type pg from 'pg';
import { connect } from './_db.ts';

interface ChangeRow {
  id: string;
  created_at: Date;
  target_id: string;
  actor: string | null;
  from_text: string | null;
  to_text: string | null;
}

/** Newest-first description diffs, joined to the actor and the task's current label. */
const LIST_SQL = `
  SELECT a.id,
         a.created_at,
         a.target_id,
         u.email                                   AS actor,
         c->>'from'                                AS from_text,
         c->>'to'                                  AS to_text,
         coalesce(nullif(t.text, ''), t.last_title) AS label,
         t.deleted_at
    FROM audit_log a
    CROSS JOIN LATERAL jsonb_array_elements(a.payload->'changes') c
    LEFT JOIN users u ON u.id = a.actor_id
    LEFT JOIN tasks t ON t.id = a.target_id
   WHERE a.target_type = 'task'
     AND c->>'field' = 'description'
     $FILTER$
   ORDER BY a.created_at DESC, a.id DESC
`;

function preview(s: string | null, n = 60): string {
  if (!s) return '(empty)';
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

/** Which database this run is actually reading — a recovery that silently hit the dev DB is worse
 *  than no answer, since "nothing found" looks identical either way. */
async function reportTarget(client: pg.Client, taskId?: string): Promise<void> {
  const { rows } = await client.query(
    `SELECT current_database() AS db,
            inet_server_addr()::text AS host,
            inet_server_port() AS port`,
  );
  const t = rows[0];
  console.log(`Reading ${t.db} at ${t.host ?? 'local socket'}:${t.port}`);
  const counts = await client.query(`SELECT count(*)::int AS n FROM audit_log`);
  console.log(`audit_log holds ${counts.rows[0].n} row(s).`);
  if (!taskId) return console.log('');

  const task = await client.query(
    `SELECT coalesce(nullif(text, ''), last_title) AS label,
            length(coalesce(description, '')) AS desc_len,
            deleted_at, created_at, updated_at, home_tab_id
       FROM tasks WHERE id = $1`,
    [taskId],
  );
  if (!task.rows.length) {
    console.log(`No task row with id ${taskId} in this database.
`);
    return;
  }
  const r = task.rows[0];
  console.log(
    `Task "${r.label ?? '(untitled)'}" on board ${r.home_tab_id}` +
    `${r.deleted_at ? ` [TRASHED ${r.deleted_at.toISOString()}]` : ''}`,
  );
  console.log(`  description now: ${r.desc_len} chars`);
  console.log(`  created ${r.created_at.toISOString()}, last updated ${r.updated_at.toISOString()}`);
  const anyTrail = await client.query(
    `SELECT count(*)::int AS n FROM audit_log WHERE target_type = 'task' AND target_id = $1`,
    [taskId],
  );
  console.log(`  ${anyTrail.rows[0].n} audit row(s) of any kind for this task
`);
}

async function main(): Promise<void> {
  const taskId = process.argv[2];
  const client = await connect();
  try {
    await reportTarget(client, taskId);
    const sql = LIST_SQL.replace('$FILTER$', taskId ? 'AND a.target_id = $1' : '');
    const { rows } = await client.query(sql, taskId ? [taskId] : []);

    if (!rows.length) {
      console.log(taskId
        ? `No description changes recorded for task ${taskId}.`
        : 'No description changes anywhere in the audit trail.');
      console.log('Either the text never reached the server, or the rows aged out of retention.');
      return;
    }

    if (!taskId) {
      console.log(`${rows.length} description change(s), newest first:\n`);
      for (const r of rows as (ChangeRow & { label: string | null; deleted_at: Date | null })[]) {
        const lost = (r.from_text?.length ?? 0) > (r.to_text?.length ?? 0);
        console.log(
          `${lost ? '!' : ' '} ${r.created_at.toISOString()}  task=${r.target_id}` +
          `${r.deleted_at ? ' [TRASHED]' : ''}  by ${r.actor ?? 'unknown'}`,
        );
        console.log(`    "${preview(r.label)}"`);
        console.log(`    ${r.from_text?.length ?? 0} chars -> ${r.to_text?.length ?? 0} chars`);
        console.log(`    was: ${preview(r.from_text)}\n`);
      }
      console.log('Lines marked ! LOST text. Re-run with a task id to print the full recovered body.');
      return;
    }

    // Single task: the longest `from` is the fullest version the trail ever saw, and the newest
    // non-empty `from` is what stood immediately before the loss. Print both when they differ.
    const changes = rows as (ChangeRow & { label: string | null })[];
    const nonEmpty = changes.filter((r) => (r.from_text ?? '').trim().length > 0);
    const newest = nonEmpty[0];
    const longest = [...nonEmpty].sort((a, b) => (b.from_text?.length ?? 0) - (a.from_text?.length ?? 0))[0];

    console.log(`Task ${taskId} — "${changes[0].label ?? '(untitled)'}"`);
    console.log(`${changes.length} description change(s) on record.\n`);
    if (!newest) {
      console.log('Every recorded change replaced an EMPTY description — nothing to recover here.');
      return;
    }

    console.log(`=== Last value before it was replaced (${newest.created_at.toISOString()}, ` +
                `by ${newest.actor ?? 'unknown'}, ${newest.from_text!.length} chars) ===\n`);
    console.log(newest.from_text);

    if (longest && longest.id !== newest.id) {
      console.log(`\n=== Longest version the trail ever held (${longest.created_at.toISOString()}, ` +
                  `${longest.from_text!.length} chars) ===\n`);
      console.log(longest.from_text);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
