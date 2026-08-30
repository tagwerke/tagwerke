// Convert any board document still holding task items, on boot (NOTES_SPLIT_PLAN §M).
//
// The document rewrite is not a SQL migration — it edits Yjs binary state, which drizzle-kit has
// no way to express — but it has exactly a migration's obligations: it must run before the code
// that assumes it has, and it must be safe to run again.
//
// Doing it here rather than as a script somebody remembers to run is what removes the ordering
// hazard entirely. A deploy that ships the client without `taskItem` in its schema cannot reach a
// document that still contains one, because the server converted it before it began serving. That
// matters because y-prosemirror maps Yjs elements onto node types BY NAME: an element with no
// matching type is not gracefully ignored.
//
// Idempotent by construction — a document with no `taskList` is not written at all — so every boot
// after the first is a read-only scan that finds nothing. `npm run migrate:notes-split` remains for
// running it by hand against a restored copy, with a dry run.

import * as Y from 'yjs';
import { eq } from 'drizzle-orm';
import { db, schema } from './client.ts';
import { convert, FRAGMENT, proseLength } from '../lib/notesSplit.ts';

interface Logger {
  info(o: unknown, msg?: string): void;
  error(o: unknown, msg?: string): void;
}

export async function convertRemainingDocs(log: Logger): Promise<void> {
  const boards = await db
    .select({ id: schema.tabs.id, name: schema.tabs.name, state: schema.tabs.ydocState })
    .from(schema.tabs);

  let converted = 0;
  let mentions = 0;
  let skipped = 0;

  for (const board of boards) {
    if (!board.state) continue;
    try {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, new Uint8Array(Buffer.from(board.state, 'base64')));
      const before = proseLength(doc.getXmlFragment(FRAGMENT));

      const counts = { lists: 0, mentions: 0, strays: 0, duplicates: 0 };
      Y.transact(doc, () => Object.assign(counts, convert(doc, new Set())));
      if (!counts.lists) { doc.destroy(); continue; }

      // The invariant. Prose is the one thing this must never touch, and a board whose prose moved
      // is left exactly as it was rather than written and reported afterwards.
      const after = proseLength(doc.getXmlFragment(FRAGMENT));
      if (before !== after) {
        log.error({ tabId: board.id, before, after }, 'notes split: prose length changed — board left untouched');
        skipped++;
        doc.destroy();
        continue;
      }

      await db
        .update(schema.tabs)
        .set({ ydocState: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64') })
        .where(eq(schema.tabs.id, board.id));
      converted++;
      mentions += counts.mentions;
      doc.destroy();
    } catch (err) {
      log.error({ err, tabId: board.id }, 'notes split: board could not be converted');
      skipped++;
    }
  }

  if (converted || skipped) log.info({ converted, mentions, skipped }, 'notes split: documents converted');
}
