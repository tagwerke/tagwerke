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

/** Whether the doc contains a taskItem with `id` (read-only). */
export function docHasTaskId(docJSON: unknown, id: string): boolean {
  let found = false;
  walk(docJSON as DocLike, (n) => {
    if (n.type === 'taskItem' && n.attrs?.id === id) found = true;
  });
  return found;
}

/** Deep-clone `docJSON` and append a taskList holding a new taskItem with `id`. Idempotent. */
export function appendTaskToDoc(docJSON: unknown, id: string, text: string): DocLike {
  const doc = docJSON ? (JSON.parse(JSON.stringify(docJSON)) as DocLike) : { type: 'doc', content: [] };
  if (docHasTaskId(doc, id)) return doc;
  const item: DocLike = {
    type: 'taskItem',
    attrs: { id },
    content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }],
  };
  doc.content = [...(doc.content ?? []), { type: 'taskList', content: [item] }];
  return doc;
}

/** Deep-clone `docJSON` and remove every taskItem whose id is in `ids`, pruning empty taskLists. */
export function removeTaskItemsFromDoc(docJSON: unknown, ids: Set<string>): DocLike {
  const doc = JSON.parse(JSON.stringify(docJSON)) as DocLike;
  const prune = (n: DocLike) => {
    if (!n.content) return;
    n.content = n.content.filter(
      (c) => !(c.type === 'taskItem' && typeof c.attrs?.id === 'string' && ids.has(c.attrs.id as string)),
    );
    n.content = n.content.filter((c) => !(c.type === 'taskList' && (c.content?.length ?? 0) === 0));
    n.content.forEach(prune);
  };
  prune(doc);
  return doc;
}

