// Read-only diagnostic for a single board's document persistence state. Prints whether the
// authoritative Yjs state (ydoc_state) exists, whether the legacy/denormalized doc_json still holds
// content, the doc schema/version, and how many task rows are homed to it. Use to decide whether a
// board whose editor opens EMPTY can be recovered (doc_json present → rebuildable) or is truly gone.
//
// Usage:  tsx server/scripts/inspect-tab.ts <tabId>
// Purely SELECTs — writes nothing.

import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';

function textLen(json: unknown): number {
  let n = 0;
  const walk = (node: unknown): void => {
    const x = node as { type?: string; text?: string; content?: unknown[] } | null;
    if (!x || typeof x !== 'object') return;
    if (x.type === 'text' && typeof x.text === 'string') n += x.text.length;
    if (Array.isArray(x.content)) x.content.forEach(walk);
  };
  walk(json);
  return n;
}

function countTaskNodes(json: unknown): number {
  let n = 0;
  const walk = (node: unknown): void => {
    const x = node as { type?: string; content?: unknown[] } | null;
    if (!x || typeof x !== 'object') return;
    if (x.type === 'taskItem') n++;
    if (Array.isArray(x.content)) x.content.forEach(walk);
  };
  walk(json);
  return n;
}

async function main(): Promise<void> {
  const id = process.argv[2];
  if (!id) {
    console.error('Usage: tsx server/scripts/inspect-tab.ts <tabId>');
    process.exit(1);
  }

  const row = (
    await db
      .select({
        name: schema.tabs.name,
        docSchema: schema.tabs.docSchema,
        docVersion: schema.tabs.docVersion,
        ydocState: schema.tabs.ydocState,
        docJSON: schema.tabs.docJSON,
      })
      .from(schema.tabs)
      .where(eq(schema.tabs.id, id))
      .limit(1)
  )[0];

  if (!row) {
    console.log(`No tabs row for id=${id}. (Row missing entirely.)`);
    process.exit(0);
  }

  const tasks = await db
    .select({ id: schema.tasks.id, text: schema.tasks.text, deletedAt: schema.tasks.deletedAt })
    .from(schema.tasks)
    .where(eq(schema.tasks.homeTabId, id));
  const live = tasks.filter((t) => !t.deletedAt);
  const trashed = tasks.filter((t) => t.deletedAt);

  console.log(`\nBoard: ${row.name}  (${id})`);
  console.log(`  doc_schema   : ${row.docSchema}`);
  console.log(`  doc_version  : ${row.docVersion}`);
  console.log(`  ydoc_state   : ${row.ydocState == null ? 'NULL (no CRDT state persisted)' : `${row.ydocState.length} b64 chars`}`);
  if (row.docJSON == null) {
    console.log(`  doc_json     : NULL  → nothing to rebuild from`);
  } else {
    console.log(`  doc_json     : PRESENT → ${textLen(row.docJSON)} chars of text, ${countTaskNodes(row.docJSON)} task node(s)`);
  }
  console.log(`  task rows    : ${live.length} live, ${trashed.length} trashed`);
  if (live.length) console.log(`    live titles   : ${live.map((t) => JSON.stringify(t.text)).slice(0, 20).join(', ')}`);
  if (trashed.length)
    console.log(`    trashed titles: ${trashed.map((t) => `${JSON.stringify(t.text)} (id=${t.id}, deletedAt=${String(t.deletedAt)})`).slice(0, 20).join(', ')}`);

  // Verdict
  const rebuildable = row.ydocState == null && row.docJSON != null && (textLen(row.docJSON) > 0 || countTaskNodes(row.docJSON) > 0);
  console.log('');
  if (rebuildable) {
    console.log('VERDICT: RECOVERABLE — doc_json holds content and no ydoc_state exists.');
    console.log('         Rebuild ydoc_state from doc_json (stop the app first).');
  } else if (row.ydocState != null) {
    console.log('VERDICT: ydoc_state already exists — inspect it before overwriting; content may be there or already empty.');
  } else {
    console.log('VERDICT: NOT recoverable from the doc — doc_json is empty/null. Task rows (if any) are the only survivors.');
  }
  console.log('');
  process.exit(0);
}

void main();
