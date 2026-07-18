// Pure transform for the tasks-as-entities doc migration (TASKS_AS_ENTITIES.md P3), extracted so it
// can be unit-tested without touching the DB. Takes legacy ProseMirror JSON (task text inside
// taskItem nodes, sub-tasks as nested taskLists) and returns a FLAT doc of id-only task-ref atoms
// plus the task list with each task's parent (from nesting) — so indentation is preserved as the
// row field parentTaskId, which the UI renders as visual indent.

import { nanoid } from 'nanoid';

export interface PMNode { type?: string; attrs?: Record<string, unknown>; content?: PMNode[]; text?: string }
export interface CollectedTask { id: string; text: string; parentId: string | null; order: number }

/** Concatenated text of a taskItem's own first paragraph (its title — excludes nested sub-lists). */
export function titleText(item: PMNode): string {
  const para = (item.content ?? []).find((c) => c.type === 'paragraph');
  let text = '';
  const walk = (nodes: PMNode[]) => {
    for (const n of nodes) {
      if (n.type === 'text' && typeof n.text === 'string') text += n.text;
      else if (n.content) walk(n.content);
    }
  };
  if (para?.content) walk(para.content);
  return text.trim();
}

/** Flatten a (possibly nested) taskList into id-only atom refs; record tasks with their parent. */
export function flattenList(list: PMNode, parentId: string | null, out: PMNode[], tasks: CollectedTask[]): void {
  for (const item of list.content ?? []) {
    if (item.type !== 'taskItem') continue;
    const id = (typeof item.attrs?.id === 'string' && item.attrs.id) || `t_${nanoid(8)}`;
    tasks.push({ id, text: titleText(item), parentId, order: tasks.length });
    out.push({ type: 'taskItem', attrs: { id } }); // atom: no content
    for (const child of item.content ?? []) {
      if (child.type === 'taskList') flattenList(child, id, out, tasks); // nested → parentId = this id
    }
  }
}

/** Build the new flat doc JSON + the task list. Prose blocks pass through untouched. */
export function transform(oldJson: PMNode): { newJson: PMNode; tasks: CollectedTask[] } {
  const tasks: CollectedTask[] = [];
  const content: PMNode[] = [];
  for (const block of oldJson.content ?? []) {
    if (block.type === 'taskList') {
      const flat: PMNode[] = [];
      flattenList(block, null, flat, tasks);
      if (flat.length) content.push({ type: 'taskList', content: flat });
    } else {
      content.push(block);
    }
  }
  return { newJson: { type: 'doc', content }, tasks };
}
