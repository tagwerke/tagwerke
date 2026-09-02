// Rewrite every board document so it holds prose and task MENTIONS instead of task items
// (NOTES_SPLIT_PLAN §M). The one irreversible step in the plan.
//
// Why before the schema, not after: y-prosemirror maps Yjs XmlElements onto ProseMirror node types
// BY NAME. Remove `taskItem` from the schema while live documents still contain those elements and
// they are not gracefully ignored. So the documents are rewritten first, and only then does a
// client that no longer knows the node type ever open one.
//
// Why convert rather than delete: a board that was twenty tasks and three paragraphs comes back as
// three orphan paragraphs under a deletion, with nothing left to say what they were about. A
// mention costs one inline node and keeps the document meaningful — and it is the rule made
// literal, since a mention references a task without owning it.
//
//   npm run migrate:notes-split -- --dry-run     inspect, change nothing
//   npm run migrate:notes-split                  rewrite
//
// Run against a RESTORED COPY of production first and diff the prose counts it prints; prose is not
// what this touches, and any change in it is a bug.

import 'dotenv/config';
import * as Y from 'yjs';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { convert, FRAGMENT, proseLength, type BoardResult } from '../lib/notesSplit.ts';

const DRY = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  const boards = await db.select({ id: schema.tabs.id, name: schema.tabs.name, state: schema.tabs.ydocState }).from(schema.tabs);
  const results: BoardResult[] = [];
  let failed = 0;

  for (const board of boards) {
    if (!board.state) continue; // never opened under the CRDT; nothing to rewrite
    try {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, new Uint8Array(Buffer.from(board.state, 'base64')));
      const proseBefore = proseLength(doc.getXmlFragment(FRAGMENT));

      const counts = { lists: 0, mentions: 0, strays: 0, duplicates: 0 };
      Y.transact(doc, () => Object.assign(counts, convert(doc, new Set())));

      const proseAfter = proseLength(doc.getXmlFragment(FRAGMENT));
      results.push({ tabId: board.id, name: board.name, ...counts, proseBefore, proseAfter });

      if (proseBefore !== proseAfter) {
        // The one thing this must never do. Never write a board whose prose moved.
        console.error(`  !! ${board.name} (${board.id}): prose ${proseBefore} → ${proseAfter} — NOT WRITTEN`);
        failed++;
        continue;
      }
      if (!counts.lists) continue; // nothing to do; leave the row untouched

      if (!DRY) {
        const next = Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
        await db.update(schema.tabs).set({ ydocState: next }).where(eq(schema.tabs.id, board.id));
      }
      doc.destroy();
    } catch (err) {
      console.error(`  !! ${board.name} (${board.id}): ${(err as Error).message}`);
      failed++;
    }
  }

  const touched = results.filter((r) => r.lists > 0);
  console.log(`\n${DRY ? 'DRY RUN — nothing written' : 'Rewritten'}`);
  console.log(`  boards with a document : ${results.length}`);
  console.log(`  boards holding tasks   : ${touched.length}`);
  console.log(`  task lists converted   : ${touched.reduce((n, r) => n + r.lists, 0)}`);
  console.log(`  mentions written       : ${touched.reduce((n, r) => n + r.mentions, 0)}`);
  console.log(`  id-less strays dropped : ${touched.reduce((n, r) => n + r.strays, 0)}`);
  console.log(`  duplicate refs merged  : ${touched.reduce((n, r) => n + r.duplicates, 0)}`);
  console.log(`  prose characters       : unchanged on every board written`);
  if (failed) console.log(`  BOARDS SKIPPED         : ${failed} — see the errors above`);

  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
