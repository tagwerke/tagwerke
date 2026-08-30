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

function main(): void {
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

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main();
