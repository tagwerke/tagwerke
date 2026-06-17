// Renders a TODAY TipTap doc to plain text for snapshots.
// Ported verbatim from renderTodayDocToText in src/store.ts so frozen snapshots
// match the previous client behavior.

interface DocLike {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: DocLike[];
}

function nodeText(n: DocLike | undefined): string {
  if (!n) return '';
  if (n.type === 'text' && typeof n.text === 'string') return n.text;
  return (n.content ?? []).map(nodeText).join('');
}

export function renderTodayDocToText(doc: unknown, dateKey: string): string {
  const root = doc as DocLike | undefined;
  if (!root || !Array.isArray(root.content)) return '';
  const lines: string[] = [`# ${dateKey}`, ''];
  for (const top of root.content) {
    if (top.type === 'paragraph') {
      const text = nodeText(top);
      if (text.trim()) lines.push(text);
      else lines.push('');
      continue;
    }
    if (top.type === 'taskList') {
      for (const item of top.content ?? []) {
        if (item.type !== 'taskItem') continue;
        const done = item.attrs?.done ? '[x]' : '[ ]';
        const text = nodeText(item.content?.[0]);
        lines.push(`- ${done} ${text}`);
      }
      continue;
    }
    const text = nodeText(top);
    if (text) lines.push(text);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
