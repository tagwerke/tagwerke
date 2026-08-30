// Verifies the document rewrite behind the notes split (NOTES_SPLIT_PLAN §M, §V).
//
// It runs the REAL conversion from lib/notesSplit.ts against a document built to contain every
// shape the live boards are known to hold — prose above and below a task list, two separate lists,
// a duplicated ref (Yjs has no atomic move, so two people dragging one task produce exactly that),
// an id-less stray, and a nested list inside a blockquote.
//
// The property that matters most is the last one: prose is not what this migration touches, and
// any change in it at all is a bug. Everything else can be rebuilt from the task rows; the prose
// cannot.
//
//   npm run verify:notes-split

import 'dotenv/config';
import * as Y from 'yjs';
import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.ts';
import { convertRemainingDocs } from '../db/notes-split-boot.ts';
import { convert, FRAGMENT, proseLength } from '../lib/notesSplit.ts';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

function para(text: string): Y.XmlElement {
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText(text)]);
  return p;
}

function taskList(ids: (string | null)[]): Y.XmlElement {
  const list = new Y.XmlElement('taskList');
  list.insert(0, ids.map((id) => {
    const item = new Y.XmlElement('taskItem');
    if (id) item.setAttribute('id', id);
    return item;
  }));
  return list;
}

/** Every element name in the document, in order. */
function names(node: Y.XmlElement | Y.XmlFragment, out: string[] = []): string[] {
  for (let i = 0; i < node.length; i++) {
    const child = node.get(i);
    if (child instanceof Y.XmlElement) {
      out.push(child.nodeName);
      names(child, out);
    }
  }
  return out;
}

function mentionIds(node: Y.XmlElement | Y.XmlFragment, out: string[] = []): string[] {
  for (let i = 0; i < node.length; i++) {
    const child = node.get(i);
    if (!(child instanceof Y.XmlElement)) continue;
    if (child.nodeName === 'taskMention') out.push(child.getAttribute('id') ?? '(none)');
    else mentionIds(child, out);
  }
  return out;
}

function checkConversion(): void {
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment(FRAGMENT);

  const quote = new Y.XmlElement('blockquote');
  quote.insert(0, [para('Quoted thinking.'), taskList(['t_nested'])]);

  frag.insert(0, [
    para('Prose above the list.'),
    taskList(['t_one', 't_two', null, 't_one']), // an id-less stray, and t_one twice
    para('Prose between two lists.'),
    taskList(['t_three']),
    quote,
    para('Prose at the end.'),
  ]);

  const proseBefore = proseLength(frag);
  const counts = { lists: 0, mentions: 0, strays: 0, duplicates: 0 };
  Y.transact(doc, () => Object.assign(counts, convert(doc, new Set())));
  const proseAfter = proseLength(frag);

  const after = names(frag);
  const ids = mentionIds(frag);

  check('prose is byte-for-byte unchanged', proseBefore === proseAfter, `${proseBefore} → ${proseAfter}`);
  check('no taskItem survives', !after.includes('taskItem'), after.filter((n) => n === 'taskItem').length + ' left');
  check('no taskList survives', !after.includes('taskList'), after.filter((n) => n === 'taskList').length + ' left');
  check('every live ref became a mention', ids.join(',') === 't_one,t_two,t_three,t_nested', `[${ids}]`);
  check('the duplicate ref merged into one', counts.duplicates === 1, `duplicates=${counts.duplicates}`);
  check('the id-less stray was dropped', counts.strays === 1, `strays=${counts.strays}`);
  check('a list nested in a quote was converted too', after.includes('blockquote') && ids.includes('t_nested'), '');
  check('every list was visited', counts.lists === 3, `lists=${counts.lists}`);

  // Idempotence: the migration will be re-run after a restore, or on a board someone reopened.
  const second = { lists: 0, mentions: 0, strays: 0, duplicates: 0 };
  Y.transact(doc, () => Object.assign(second, convert(doc, new Set())));
  check('running it twice changes nothing', second.lists === 0 && proseLength(frag) === proseBefore, `lists=${second.lists}`);

  // A document that never held a task must come out untouched, structure included.
  const plain = new Y.Doc();
  plain.getXmlFragment(FRAGMENT).insert(0, [para('Just thinking, no tasks.')]);
  const plainBefore = names(plain.getXmlFragment(FRAGMENT)).join(',');
  Y.transact(plain, () => convert(plain, new Set()));
  check('a prose-only document is untouched', names(plain.getXmlFragment(FRAGMENT)).join(',') === plainBefore, '');
}

const BOARD = 'vns_board';
const quiet = { info: () => {}, error: (o: unknown) => console.error('  boot:', o) };

async function storedState(): Promise<string | null> {
  const row = (await db.select({ s: schema.tabs.ydocState }).from(schema.tabs).where(eq(schema.tabs.id, BOARD)).limit(1))[0];
  return row?.s ?? null;
}

async function storedFragment(): Promise<Y.XmlFragment> {
  const state = await storedState();
  const d = new Y.Doc();
  Y.applyUpdate(d, new Uint8Array(Buffer.from(state!, 'base64')));
  return d.getXmlFragment(FRAGMENT);
}

/**
 * The same conversion as it actually runs: on boot, against the database. This is the path that
 * makes the client safe to deploy against un-converted documents, so it is the one worth
 * exercising against a real row rather than an in-memory doc.
 */
async function checkBootConversion(): Promise<void> {
  await db.delete(schema.tabs).where(inArray(schema.tabs.id, [BOARD]));

  const doc = new Y.Doc();
  doc.getXmlFragment(FRAGMENT).insert(0, [para('Notes above.'), taskList(['t_a', 't_b'])]);
  const before = proseLength(doc.getXmlFragment(FRAGMENT));
  await db.insert(schema.tabs).values({
    id: BOARD,
    name: 'verify notes split',
    ydocState: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'),
  });

  await convertRemainingDocs(quiet);

  const frag = await storedFragment();
  check('boot: the stored document is converted', !names(frag).includes('taskItem'), `[${names(frag)}]`);
  check('boot: mentions carry the same ids', mentionIds(frag).join(',') === 't_a,t_b', `[${mentionIds(frag)}]`);
  check('boot: prose survives the round-trip', proseLength(frag) === before, `${before} -> ${proseLength(frag)}`);

  // Every boot after the first must be a no-op scan, not another rewrite.
  const first = await storedState();
  await convertRemainingDocs(quiet);
  check('boot: a second boot writes nothing', first === (await storedState()), '');

  await db.delete(schema.tabs).where(inArray(schema.tabs.id, [BOARD]));
}

async function main(): Promise<void> {
  checkConversion();
  await checkBootConversion();
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
