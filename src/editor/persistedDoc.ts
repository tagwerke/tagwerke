// Mutating helpers for a tab's serialized ProseMirror doc (docJSON). Used when the
// home tab's live editor isn't mounted, so an edit has to be written into the stored
// JSON instead of dispatched as a transaction.

export interface DocLike {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: DocLike[];
}

function walk(node: DocLike, visit: (n: DocLike) => void): void {
  visit(node);
  node.content?.forEach((child) => walk(child, visit));
}

/** Deep-clone `docJSON` and set the text of the taskItem with `id`. */
export function setTaskTextInDoc(docJSON: unknown, id: string, text: string): DocLike {
  const doc = JSON.parse(JSON.stringify(docJSON)) as DocLike;
  walk(doc, (n) => {
    if (n.type === 'taskItem' && n.attrs?.id === id) {
      const para = n.content?.[0];
      if (para) para.content = text ? [{ type: 'text', text }] : [];
    }
  });
  return doc;
}

