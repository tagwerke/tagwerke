// The document surgery behind the notes split (NOTES_SPLIT_PLAN §M), kept apart from the script
// that drives it so the verification can exercise exactly the code that runs against real boards
// rather than a second copy of it that might disagree.

import * as Y from 'yjs';

export const FRAGMENT = 'default';
export interface BoardResult {
  tabId: string;
  name: string;
  lists: number;
  mentions: number;
  strays: number;
  duplicates: number;
  proseBefore: number;
  proseAfter: number;
}

/** Every character of prose in the document, ignoring structure. The migration's invariant. */
export function proseLength(node: Y.XmlElement | Y.XmlFragment): number {
  let n = 0;
  for (let i = 0; i < node.length; i++) {
    const child = node.get(i);
    if (child instanceof Y.XmlText) n += child.toString().length;
    else if (child instanceof Y.XmlElement) n += proseLength(child);
  }
  return n;
}

/**
 * Replace each `taskList` with one `paragraph` per surviving `taskItem`, each holding a single
 * inline `taskMention` carrying the same id.
 *
 * Walks in reverse so deletions never shift an index still to be visited, and keeps a set of ids
 * already emitted so a duplicated ref — which Yjs produces routinely, since it has no atomic move
 * and two people dragging the same task make one — becomes a single mention rather than two.
 */
export function convert(doc: Y.Doc, seen: Set<string>): Omit<BoardResult, 'tabId' | 'name' | 'proseBefore' | 'proseAfter'> {
  const frag = doc.getXmlFragment(FRAGMENT);
  let lists = 0;
  let mentions = 0;
  let strays = 0;
  let duplicates = 0;

  const walk = (node: Y.XmlElement | Y.XmlFragment): void => {
    for (let i = node.length - 1; i >= 0; i--) {
      const child = node.get(i);
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName !== 'taskList') {
        walk(child);
        continue;
      }

      lists++;
      const paragraphs: Y.XmlElement[] = [];
      for (let j = 0; j < child.length; j++) {
        const item = child.get(j);
        if (!(item instanceof Y.XmlElement) || item.nodeName !== 'taskItem') continue;
        const id = item.getAttribute('id');
        if (!id) { strays++; continue; }
        if (seen.has(id)) { duplicates++; continue; }
        seen.add(id);
        const mention = new Y.XmlElement('taskMention');
        mention.setAttribute('id', id);
        const para = new Y.XmlElement('paragraph');
        para.insert(0, [mention]);
        paragraphs.push(para);
        mentions++;
      }

      node.delete(i, 1);
      if (paragraphs.length) node.insert(i, paragraphs);
    }
  };

  walk(frag);
  return { lists, mentions, strays, duplicates };
}

