// Incident companion to migrate-doc-schema.ts (2026-07-18, CSCA restore — see
// internal/docs/inc/). Covers the class that script skips: boards with doc_schema < 2 whose
// ydoc_state is NULL but whose doc_json still holds LEGACY content (text-bearing taskItem
// nodes). The main script stamps those to schema 2 untransformed, which leaves a legacy
// docJSON to be seeded into a new-schema client on first open — the exact corruption the
// migration exists to prevent. This script instead builds the new-schema Yjs doc SERVER-SIDE
// from doc_json via the same transform, so no client seed (and no seed race) is involved.
//
// Usage:  tsx server/scripts/migrate-docjson-null-ydoc.ts          # migrate
//         tsx server/scripts/migrate-docjson-null-ydoc.ts --dry    # report only
//
// Run BEFORE migrate-doc-schema.ts (this stamps its boards to schema 2, so the main script
// then only sees the ydoc-bearing rest). App must be stopped: a live room could re-persist
// an in-memory doc over these writes.

import 'dotenv/config';
import * as Y from 'yjs';
import { yDocToProsemirrorJSON, prosemirrorJSONToYDoc } from 'y-prosemirror';
import { getSchema, Node } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { and, eq, isNull, isNotNull, lt } from 'drizzle-orm';
import { db, schema as dbschema } from '../db/client.ts';
import { transform, type PMNode } from './lib/migrate-transform.ts';

const FRAGMENT = 'default';
const DRY = process.argv.includes('--dry');

// Same schema SHAPE as migrate-doc-schema.ts / Editor.tsx (see comments there).
const TaskListSchema = Node.create({ name: 'taskList', group: 'block list', content: 'taskItem+' });
const TaskItemSchema = Node.create({ name: 'taskItem', atom: true, addAttributes: () => ({ id: { default: null } }) });
const schema = getSchema([
  StarterKit.configure({ bulletList: false, orderedList: false, listItem: false, codeBlock: false, heading: { levels: [1, 2, 3] } }),
  TaskListSchema,
  TaskItemSchema,
]);

async function main(): Promise<void> {
  const tabs = await db
    .select({ id: dbschema.tabs.id, name: dbschema.tabs.name, docJSON: dbschema.tabs.docJSON })
    .from(dbschema.tabs)
    .where(and(lt(dbschema.tabs.docSchema, 2), isNull(dbschema.tabs.ydocState), isNotNull(dbschema.tabs.docJSON)));

  console.log(`${DRY ? '[DRY] ' : ''}${tabs.length} board(s): doc_schema < 2, no ydoc, docJSON present`);
  for (const tab of tabs) {
    const { newJson, tasks } = transform(tab.docJSON as PMNode);
    if (!tasks.length) {
      // Prose-only docJSON is valid under the new schema; the normal first-open seed is safe.
      if (!DRY) await db.update(dbschema.tabs).set({ docSchema: 2 }).where(eq(dbschema.tabs.id, tab.id));
      console.log(`  ${tab.name} (${tab.id}): prose only → stamped schema 2`);
      continue;
    }
    if (!DRY) {
      for (const t of tasks) {
        await db
          .insert(dbschema.tasks)
          .values({ id: t.id, homeTabId: tab.id, text: t.text, lastTitle: t.text || null, parentTaskId: t.parentId })
          .onConflictDoUpdate({ target: dbschema.tasks.id, set: { parentTaskId: t.parentId } });
      }
      const newDoc = prosemirrorJSONToYDoc(schema, newJson, FRAGMENT);
      const ydocState = Buffer.from(Y.encodeStateAsUpdate(newDoc)).toString('base64');
      const docJSON = yDocToProsemirrorJSON(newDoc, FRAGMENT);
      newDoc.destroy();
      await db.update(dbschema.tabs).set({ ydocState, docJSON, docSchema: 2 }).where(eq(dbschema.tabs.id, tab.id));
    }
    console.log(`  ${tab.name} (${tab.id}): ${tasks.length} task(s) → server-built atom doc${DRY ? '' : ', schema 2'}`);
  }
  console.log(DRY ? '[DRY] done.' : 'done.');
  process.exit(0);
}

void main();
