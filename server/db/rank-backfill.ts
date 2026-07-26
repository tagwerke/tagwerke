// SUBTASKS_PLAN P2/P7 — the one-shot `tasks.rank` backfill, as a library.
//
// Two callers share it: the CLI (server/scripts/backfill-task-rank.ts), for an operator who wants a
// dry run and a report, and the boot sequence (server/db/ensure-rank.ts), which has to rank an
// upgrading instance BEFORE migration 0027 drops `position`. An unattended container has nobody to
// run a script between two migrations, and drizzle applies the whole pending batch in a single
// transaction — so there is no moment in between to run one.
//
// The order it assigns is DEFINING: after this runs, `rank` is what every view sorts by, so getting
// it wrong silently reshuffles every board. The order is taken from the one place that actually
// holds a meaningful task order today — the document's ref sequence — read from `ydoc_state` (the
// authoritative Yjs bytes) rather than `doc_json`, whose derive is best-effort and can lag behind
// (see writeState() in server/realtime/ydoc.ts).
//
// Rows are grouped by parent and ranked in the order their ref appears in the doc. Rows with no ref
// at all — soft-deleted tasks (whose refs were pruned), and any row whose create was dropped — are
// appended after the ranked ones in creation order. Soft-deleted rows ARE ranked, so restoring one
// later doesn't produce an unranked task.
//
// It reads through the raw pool rather than the drizzle schema on purpose. It runs against a
// database that is MID-UPGRADE, where columns the current schema takes for granted may not exist
// yet: an instance coming from v0.1.0 has no `parent_task_id` (0023) and possibly no `ydoc_state`
// (0020). Each is probed and substituted with a constant when absent, so on an old instance the
// backfill degrades to "one flat group in creation order" instead of erroring — which is the right
// answer there, because a database with no sub-tasks and no CRDT state has no richer order to
// preserve.

import * as Y from 'yjs';
import { pool } from './client.ts';
import { isValidRank, rankSequence } from '../../shared/rank.ts';

const FRAGMENT = 'default';

export interface RankUpdate {
  id: string;
  rank: string;
}

export interface BoardPlan {
  id: string;
  name: string | null;
  tasks: number;
  groups: number;
  docRefs: number;
  withoutRef: number;
  /** Rows this plan would write. */
  ranked: number;
  /** Rows left alone because they already carry a valid rank. */
  skipped: number;
  updates: RankUpdate[];
  preview: { rank: string; label: string; child: boolean; trashed: boolean }[];
}

interface TaskRow {
  id: string;
  parentTaskId: string | null;
  rank: string | null;
  text: string;
  deletedAt: Date | null;
}

export async function tableExists(table: string): Promise<boolean> {
  const { rows } = await pool.query<{ reg: string | null }>('select to_regclass($1) as reg', [`public.${table}`]);
  return rows[0]?.reg != null;
}

export async function columnExists(table: string, column: string): Promise<boolean> {
  const { rows } = await pool.query(
    `select 1 from information_schema.columns
      where table_schema = 'public' and table_name = $1 and column_name = $2`,
    [table, column],
  );
  return rows.length > 0;
}

interface Columns {
  rank: boolean;
  parent: boolean;
  deleted: boolean;
  ydoc: boolean;
}

async function detectColumns(): Promise<Columns> {
  const [rank, parent, deleted, ydoc] = await Promise.all([
    columnExists('tasks', 'rank'),
    columnExists('tasks', 'parent_task_id'),
    columnExists('tasks', 'deleted_at'),
    columnExists('tabs', 'ydoc_state'),
  ]);
  return { rank, parent, deleted, ydoc };
}

/** Task-ref ids in document order. Duplicates collapse to their first appearance. */
function docRefOrder(ydocState: string | null): string[] {
  if (!ydocState) return [];
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, new Uint8Array(Buffer.from(ydocState, 'base64')));
  } catch {
    doc.destroy();
    return []; // unreadable state → fall back to creation order
  }
  const seen = new Set<string>();
  const out: string[] = [];
  const walk = (node: Y.XmlElement | Y.XmlFragment): void => {
    for (let i = 0; i < node.length; i++) {
      const child = node.get(i);
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === 'taskItem') {
        const id = child.getAttribute('id');
        if (id && !seen.has(id)) {
          seen.add(id);
          out.push(id);
        }
      } else {
        walk(child);
      }
    }
  };
  walk(doc.getXmlFragment(FRAGMENT));
  doc.destroy();
  return out;
}

/**
 * The order tasks should be ranked in, per parent group. Doc order first (that is the order a user
 * has actually arranged), then everything without a ref, in creation order.
 */
function orderedGroups(rows: TaskRow[], docOrder: string[]): Map<string | null, TaskRow[]> {
  const docRank = new Map(docOrder.map((id, i) => [id, i]));
  const ordered = [...rows].sort((a, b) => {
    const da = docRank.get(a.id);
    const db = docRank.get(b.id);
    if (da != null && db != null) return da - db;
    if (da != null) return -1; // in the doc beats not in the doc
    if (db != null) return 1;
    return 0; // neither is in the doc — a stable sort keeps the created_at order they arrived in
  });

  const groups = new Map<string | null, TaskRow[]>();
  for (const r of ordered) {
    const key = r.parentTaskId;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  return groups;
}

/** Live tasks that still have no rank — the exact population migration 0027's guard counts. */
export async function unrankedLiveTaskCount(): Promise<number> {
  const cols = await detectColumns();
  if (!cols.rank) return 0; // pre-0026: the column itself is still to come
  const { rows } = await pool.query<{ n: string }>(
    `select count(*) as n from tasks where rank is null${cols.deleted ? ' and deleted_at is null' : ''}`,
  );
  return Number(rows[0].n);
}

/**
 * What the backfill WOULD write, per board. Reads only — nothing is committed until the caller
 * passes the updates to writeRankUpdates().
 */
export async function planRankBackfill(
  opts: { boardId?: string | null; force?: boolean } = {},
): Promise<BoardPlan[]> {
  const { boardId = null, force = false } = opts;
  const cols = await detectColumns();

  const boards = (
    await pool.query<{ id: string; name: string | null; ydoc_state: string | null }>(
      `select id, name, ${cols.ydoc ? 'ydoc_state' : 'null::text as ydoc_state'} from tabs
        ${boardId ? 'where id = $1' : ''}`,
      boardId ? [boardId] : [],
    )
  ).rows;

  const plans: BoardPlan[] = [];

  for (const board of boards) {
    // created_at, then id: without the tiebreak the order of same-timestamp rows is whatever the
    // scan returns, and the ranks this assigns would differ between a dry run and the apply.
    const rows = (
      await pool.query(
        `select id,
                ${cols.parent ? 'parent_task_id' : 'null::text as parent_task_id'} as parent_task_id,
                ${cols.rank ? 'rank' : 'null::text as rank'} as rank,
                coalesce(text, '') as text,
                ${cols.deleted ? 'deleted_at' : 'null::timestamptz as deleted_at'} as deleted_at
           from tasks where home_tab_id = $1 order by created_at asc, id asc`,
        [board.id],
      )
    ).rows.map(
      (r): TaskRow => ({
        id: r.id,
        parentTaskId: r.parent_task_id,
        rank: r.rank,
        text: r.text,
        deletedAt: r.deleted_at,
      }),
    );

    if (!rows.length) continue;

    const docOrder = docRefOrder(board.ydoc_state);
    const groups = orderedGroups(rows, docOrder);

    const updates: RankUpdate[] = [];
    const preview: BoardPlan['preview'] = [];
    let skipped = 0;

    for (const [parentId, group] of groups) {
      const keys = rankSequence(group.length);
      group.forEach((row, i) => {
        if (!force && isValidRank(row.rank)) {
          skipped++;
          return;
        }
        updates.push({ id: row.id, rank: keys[i] });
        if (preview.length < 8) {
          preview.push({
            rank: keys[i],
            label: (row.text || '(untitled)').slice(0, 44),
            child: parentId != null,
            trashed: row.deletedAt != null,
          });
        }
      });
    }

    const refSet = new Set(docOrder);
    plans.push({
      id: board.id,
      name: board.name,
      tasks: rows.length,
      groups: groups.size,
      docRefs: docOrder.length,
      withoutRef: rows.filter((r) => !refSet.has(r.id)).length,
      ranked: updates.length,
      skipped,
      updates,
      preview,
    });
  }

  return plans;
}

/**
 * Commit the planned ranks. Chunked so one enormous instance doesn't build a single unbounded
 * transaction; each chunk is one statement, so a board of a few thousand tasks is a handful of
 * round trips rather than a few thousand.
 */
export async function writeRankUpdates(
  updates: RankUpdate[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const slice = updates.slice(i, i + CHUNK);
    await pool.query(
      `update tasks as t set rank = v.rank
         from unnest($1::text[], $2::text[]) as v(id, rank)
        where t.id = v.id`,
      [slice.map((u) => u.id), slice.map((u) => u.rank)],
    );
    onProgress?.(Math.min(i + CHUNK, updates.length), updates.length);
  }
}
