// One-time migration to the tasks-as-entities doc model (TASKS_AS_ENTITIES.md P3).
//
// Legacy boards store task text INSIDE taskItem nodes, and sub-tasks as nested taskLists. The new
// model: taskItem is an id-only atom (text lives on the row), the doc is a FLAT list of refs, and
// nesting is the row field parentTaskId. This script rewrites each board's Yjs doc once:
//   1. read the old doc as ProseMirror JSON (schema-free, via yDocToProsemirrorJSON),
//   2. collect every taskItem's {id, title text, parent (from nesting), order},
//   3. ensure a row exists per task (text if missing, parentTaskId always) — no text is lost,
//   4. rebuild the doc: prose blocks kept verbatim, each taskList flattened to id-only atoms,
//   5. re-encode via the NEW schema (prose marks survive) and stamp tabs.doc_schema = 2.
//
// MUST run server-side BEFORE any new-schema client opens the board: opening a legacy doc under the
// atom schema makes ProseMirror lift the task text out to prose, corrupting the association.
//
// Usage:  npm run migrate-docs           # migrate every board with doc_schema < 2
//         npm run migrate-docs -- --dry  # report only, write nothing

import 'dotenv/config';
import * as Y from 'yjs';
import { yDocToProsemirrorJSON, prosemirrorJSONToYDoc } from 'y-prosemirror';
import { getSchema, Node } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { and, eq, isNull, lt } from 'drizzle-orm';
import { db, schema as dbschema } from '../db/client.ts';
import { transform, type PMNode } from './lib/migrate-transform.ts';

const FRAGMENT = 'default';
const DRY = process.argv.includes('--dry');

// The NEW editor schema (taskItem = id-only atom). Defined inline here as schema SHAPE ONLY
// (node names / content model / attrs) so this server script imports NO client editor code (which
// pulls in DOM-using modules). This must match Editor.tsx's node types + StarterKit config so prose
// and marks round-trip through prosemirrorJSONToYDoc; only parseHTML/renderHTML differ, and those
// don't affect the Yjs representation (attrs are stored by name).
const TaskListSchema = Node.create({ name: 'taskList', group: 'block list', content: 'taskItem+' });
const TaskItemSchema = Node.create({ name: 'taskItem', atom: true, addAttributes: () => ({ id: { default: null } }) });
const schema = getSchema([
  StarterKit.configure({ bulletList: false, orderedList: false, listItem: false, codeBlock: false, heading: { levels: [1, 2, 3] } }),
  TaskListSchema,
  TaskItemSchema,
]);

async function migrateBoard(tabId: string, ydocStateB64: string): Promise<{ tasks: number; changed: boolean }> {
  const oldDoc = new Y.Doc();
  Y.applyUpdate(oldDoc, new Uint8Array(Buffer.from(ydocStateB64, 'base64')));
  const oldJson = yDocToProsemirrorJSON(oldDoc, FRAGMENT) as PMNode;
  oldDoc.destroy();

  const { newJson, tasks } = transform(oldJson);
  if (!tasks.length) return { tasks: 0, changed: false }; // prose-only board: nothing to flatten

  if (!DRY) {
    // Ensure rows: create any missing (with the doc text), and set parentTaskId from nesting for all.
    for (const t of tasks) {
      await db
        .insert(dbschema.tasks)
        .values({ id: t.id, homeTabId: tabId, text: t.text, lastTitle: t.text || null, parentTaskId: t.parentId })
        .onConflictDoUpdate({ target: dbschema.tasks.id, set: { parentTaskId: t.parentId } });
    }
    // Rebuild the Yjs doc from the new JSON under the new schema, then stamp it live.
    const newDoc = prosemirrorJSONToYDoc(schema, newJson, FRAGMENT);
    const ydocState = Buffer.from(Y.encodeStateAsUpdate(newDoc)).toString('base64');
    const docJSON = yDocToProsemirrorJSON(newDoc, FRAGMENT);
    newDoc.destroy();
    await db.update(dbschema.tabs).set({ ydocState, docJSON, docSchema: 2 }).where(eq(dbschema.tabs.id, tabId));
  }
  return { tasks: tasks.length, changed: true };
}

async function main(): Promise<void> {
  const tabs = await db
    .select({ id: dbschema.tabs.id, name: dbschema.tabs.name, ydocState: dbschema.tabs.ydocState })
    .from(dbschema.tabs)
    .where(lt(dbschema.tabs.docSchema, 2));

  console.log(`${DRY ? '[DRY] ' : ''}${tabs.length} board(s) below doc_schema 2`);
  let migrated = 0;
  for (const tab of tabs) {
    if (!tab.ydocState) {
      // No Yjs doc yet (never opened under CRDT) — nothing to transform. Stamp it current so a
      // fresh atom-model doc is created cleanly on first open.
      if (!DRY) await db.update(dbschema.tabs).set({ docSchema: 2 }).where(eq(dbschema.tabs.id, tab.id));
      console.log(`  ${tab.name} (${tab.id}): no ydoc → stamped schema 2`);
      continue;
    }
    try {
      const r = await migrateBoard(tab.id, tab.ydocState);
      if (r.changed) {
        migrated++;
        console.log(`  ${tab.name} (${tab.id}): ${r.tasks} task(s) flattened → atoms${DRY ? '' : ', schema 2'}`);
      } else {
        if (!DRY) await db.update(dbschema.tabs).set({ docSchema: 2 }).where(eq(dbschema.tabs.id, tab.id));
        console.log(`  ${tab.name} (${tab.id}): prose only → stamped schema 2`);
      }
    } catch (err) {
      console.error(`  ${tab.name} (${tab.id}): FAILED — left at schema 1`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`${DRY ? '[DRY] would migrate' : 'migrated'} ${migrated} board(s) with tasks.`);

  // Sanity: any live task whose home board is still legacy (shouldn't happen after a full run).
  const straggler = await db
    .select({ n: dbschema.tasks.id })
    .from(dbschema.tasks)
    .innerJoin(dbschema.tabs, eq(dbschema.tabs.id, dbschema.tasks.homeTabId))
    .where(and(isNull(dbschema.tasks.deletedAt), lt(dbschema.tabs.docSchema, 2)))
    .limit(1);
  if (straggler.length) console.log('  note: live tasks remain on boards still < schema 2 (see failures above).');

  process.exit(0);
}

void main();
