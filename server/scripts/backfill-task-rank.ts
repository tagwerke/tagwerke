// SUBTASKS_PLAN P2 — one-shot backfill of `tasks.rank`, the fractional sibling order.
//
// The order it assigns is DEFINING: after this runs, `rank` is what every view sorts by, so
// getting it wrong silently reshuffles every board. The order is taken from the one place that
// actually holds a meaningful task order today — the document's ref sequence — read from
// `ydoc_state` (the authoritative Yjs bytes) rather than `doc_json`, whose derive is best-effort
// and can lag behind (see writeState() in server/realtime/ydoc.ts).
//
// Rows are grouped by parent and ranked in the order their ref appears in the doc. Rows with no
// ref at all — soft-deleted tasks (whose refs were pruned), and any row whose create was dropped —
// are appended after the ranked ones, ordered by the legacy `position` then `created_at`.
// Soft-deleted rows ARE ranked, so restoring one later doesn't produce an unranked task.
//
// Usage:
//   tsx server/scripts/backfill-task-rank.ts            # dry run: report only, writes nothing
//   tsx server/scripts/backfill-task-rank.ts --apply    # write the ranks
//   tsx server/scripts/backfill-task-rank.ts --board <tabId> [--apply]
//
// Idempotent: rows that already have a valid rank are left alone unless --force is passed.

import 'dotenv/config';
import * as Y from 'yjs';
import { asc, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { isValidRank, rankSequence } from '../../shared/rank.ts';

const FRAGMENT = 'default';

interface TaskRow {
  id: string;
  homeTabId: string;
  parentTaskId: string | null;
  rank: string | null;
  position: number;
  text: string;
  deletedAt: Date | null;
}

/** Task-ref ids in document order. Duplicates collapse to their first appearance. */
function docRefOrder(ydocState: string | null): string[] {
  if (!ydocState) return [];
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, new Uint8Array(Buffer.from(ydocState, 'base64')));
  } catch {
    doc.destroy();
    return []; // unreadable state → fall back to position/created_at ordering
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
 * has actually arranged), then everything without a ref, by legacy position then creation time.
 */
function orderedGroups(rows: TaskRow[], docOrder: string[]): Map<string | null, TaskRow[]> {
  const docRank = new Map(docOrder.map((id, i) => [id, i]));
  const ordered = [...rows].sort((a, b) => {
    const da = docRank.get(a.id);
    const db_ = docRank.get(b.id);
    if (da != null && db_ != null) return da - db_;
    if (da != null) return -1; // in the doc beats not in the doc
    if (db_ != null) return 1;
    if (a.position !== b.position) return a.position - b.position;
    return a.id < b.id ? -1 : 1; // rows arrive in created_at order; id is the stable tiebreak
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const force = argv.includes('--force');
  const boardArg = argv.indexOf('--board');
  const onlyBoard = boardArg >= 0 ? argv[boardArg + 1] : null;

  const boards = onlyBoard
    ? await db.select({ id: schema.tabs.id, name: schema.tabs.name, ydocState: schema.tabs.ydocState }).from(schema.tabs).where(eq(schema.tabs.id, onlyBoard))
    : await db.select({ id: schema.tabs.id, name: schema.tabs.name, ydocState: schema.tabs.ydocState }).from(schema.tabs);

  if (!boards.length) {
    console.error(onlyBoard ? `No board with id ${onlyBoard}.` : 'No boards found.');
    process.exit(1);
  }

  console.log(`${apply ? 'APPLYING' : 'DRY RUN'} — ${boards.length} board(s)\n`);

  let totalRanked = 0;
  let totalSkipped = 0;
  const updates: { id: string; rank: string }[] = [];

  for (const board of boards) {
    const rows = (await db
      .select({
        id: schema.tasks.id,
        homeTabId: schema.tasks.homeTabId,
        parentTaskId: schema.tasks.parentTaskId,
        rank: schema.tasks.rank,
        position: schema.tasks.position,
        text: schema.tasks.text,
        deletedAt: schema.tasks.deletedAt,
      })
      .from(schema.tasks)
      .where(eq(schema.tasks.homeTabId, board.id))
      .orderBy(asc(schema.tasks.createdAt))) as TaskRow[];

    if (!rows.length) continue;

    const docOrder = docRefOrder(board.ydocState);
    const groups = orderedGroups(rows, docOrder);

    let ranked = 0;
    let skipped = 0;
    const preview: string[] = [];

    for (const [parentId, group] of groups) {
      const keys = rankSequence(group.length);
      group.forEach((row, i) => {
        if (!force && isValidRank(row.rank)) {
          skipped++;
          return;
        }
        updates.push({ id: row.id, rank: keys[i] });
        ranked++;
        if (preview.length < 8) {
          const label = (row.text || '(untitled)').slice(0, 44);
          preview.push(`      ${keys[i].padEnd(5)} ${parentId ? '└ ' : ''}${label}${row.deletedAt ? '  [trashed]' : ''}`);
        }
      });
    }

    totalRanked += ranked;
    totalSkipped += skipped;
    const refSet = new Set(docOrder);
    const noRef = rows.filter((r) => !refSet.has(r.id)).length;
    console.log(`  ${board.name || board.id}`);
    console.log(`      ${rows.length} task(s), ${groups.size} parent group(s), ${docOrder.length} doc ref(s), ${noRef} without a ref`);
    console.log(`      ${ranked} to rank, ${skipped} already ranked`);
    if (preview.length) console.log(preview.join('\n'));
    console.log('');
  }

  console.log(`Total: ${totalRanked} to rank, ${totalSkipped} already ranked.`);

  if (!apply) {
    console.log('\nDry run — nothing written. Re-run with --apply to commit.');
    process.exit(0);
  }

  // Chunked so one enormous instance doesn't build a single unbounded transaction.
  const CHUNK = 500;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const slice = updates.slice(i, i + CHUNK);
    await db.transaction(async (tx) => {
      for (const u of slice) {
        await tx.update(schema.tasks).set({ rank: u.rank }).where(eq(schema.tasks.id, u.id));
      }
    });
    console.log(`  wrote ${Math.min(i + CHUNK, updates.length)}/${updates.length}`);
  }

  // Post-condition: every task on the boards we touched must now carry a valid rank.
  const ids = boards.map((b) => b.id);
  const remaining = ids.length
    ? await db.select({ id: schema.tasks.id, rank: schema.tasks.rank }).from(schema.tasks).where(inArray(schema.tasks.homeTabId, ids))
    : [];
  const bad = remaining.filter((r) => !isValidRank(r.rank));
  if (bad.length) {
    console.error(`\nFAIL: ${bad.length} task(s) still without a valid rank, e.g. ${bad.slice(0, 5).map((b) => b.id).join(', ')}`);
    process.exit(1);
  }
  console.log(`\nDone. ${updates.length} task(s) ranked; all ${remaining.length} verified.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
