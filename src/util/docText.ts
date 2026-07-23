// Plain-text extraction from a board's ProseMirror-JSON doc snapshot (`Tab.docJSON`), so search/
// filter can match the free-form prose typed into a board, not just task titles and tab names.
// Skips `taskItem` nodes deliberately: tasks-as-entities moved task text onto the `tasks` row, so
// a taskItem node in the doc is just an id-only reference — walking into it either finds nothing
// or (on an old, not-yet-migrated doc) would duplicate what the task-text match already covers.

interface DocLike { type: string; text?: string; content?: DocLike[] }

export function extractDocText(docJSON: unknown): string {
  const parts: string[] = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    const node = n as DocLike;
    if (node.type === 'taskItem') return;
    if (typeof node.text === 'string') parts.push(node.text);
    if (Array.isArray(node.content)) for (const child of node.content) walk(child);
  };
  walk(docJSON);
  return parts.join(' ');
}
