// Node view for a task REFERENCE atom. Since SUBTASKS_PLAN D2 a ref means "the task tree ROOTED at
// this id appears here in the prose" — so this renders the root's own row plus its whole subtree,
// read from the store rows. Children have no node in the document at all.
//
// The task's title and metadata live on the entity (store.tasks[id]); TaskLine renders them and
// owns the structural keys. The node is an atom with stopEvent:()=>true (see Editor.tsx), so
// ProseMirror leaves the widgets' own keyboard and selection alone.

import { useMemo } from 'react';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import type { Editor } from '@tiptap/react';
import { childrenOf, useStore } from '../store';
import { MAX_TASK_DEPTH } from '../../shared/tree';
import { TaskLine } from './TaskLine';
import type { ID } from '../types';

/** One level of sub-tasks, recursively. Ordered by rank; depth-capped as a corruption guard. */
function SubtaskList({ parentId, tabId, editor, depth }: { parentId: ID; tabId: ID; editor: Editor; depth: number }) {
  // Subscribe to the whole tasks map (stable identity between writes) and derive from it, so a
  // child added, re-ranked or re-parented anywhere re-renders exactly the lists containing it.
  const tasks = useStore((s) => s.tasks);
  const kids = useMemo(() => childrenOf(tasks, parentId), [tasks, parentId]);
  if (!kids.length || depth > MAX_TASK_DEPTH) return null;
  return (
    <ul className="task-children" data-depth={depth}>
      {kids.map((child) => (
        <TaskLine key={child.id} id={child.id} tabId={tabId} editor={editor} depth={depth}>
          <SubtaskList parentId={child.id} tabId={tabId} editor={editor} depth={depth + 1} />
        </TaskLine>
      ))}
    </ul>
  );
}

export function TaskItemView({ node, editor, getPos, extension }: NodeViewProps) {
  const id: string | null = node.attrs.id ?? null;
  const tabId: ID = (extension.options as { tabId: ID }).tabId;

  // `display: contents` on the wrapper (see .task-root) so the <li> TaskLine renders is the direct
  // layout child of the enclosing taskList <ul>, and the nested sub-task <ul> stays valid HTML
  // inside it. TipTap always renders a wrapper element; this makes it disappear from layout.
  if (!id) {
    // An idless ref is a broken reference — no row exists to look it up in. The server's reconcile
    // sweep prunes these; render nothing rather than a blank row in the meantime.
    return <NodeViewWrapper as="div" className="task-root" />;
  }

  return (
    <NodeViewWrapper as="div" className="task-root" data-root-id={id}>
      <TaskLine id={id} tabId={tabId} editor={editor} getPos={getPos} depth={0}>
        <SubtaskList parentId={id} tabId={tabId} editor={editor} depth={1} />
      </TaskLine>
    </NodeViewWrapper>
  );
}
