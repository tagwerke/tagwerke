// "What is this part of?" for a sub-task shown outside the board's tree (SUBTASKS_PLAN P5/D10).
//
// Every view except the doc and List's outline mode groups by something that cuts ACROSS a family —
// status columns, assignee, due date — so a parent and its child routinely land in different
// sections. Indentation cannot survive that: there is nothing above the child to indent from. The
// parent's name can, and it works in any grouping, any filter, and even when the parent is
// off-screen.
//
// Two shapes for two densities:
//   inline  — `Draft Q3 landing page › Write copy`, on the title line (List rows)
//   caption — a `↳ Draft Q3 landing page` line above the title (Kanban cards, which have room)

import { useStore } from '../../store';
import type { ID } from '../../types';

export function TaskParentPath({ taskId, variant = 'inline' }: { taskId: ID; variant?: 'inline' | 'caption' }) {
  const parent = useStore((s) => {
    const parentId = s.tasks[taskId]?.parentTaskId;
    return parentId ? s.tasks[parentId] : undefined;
  });
  const setActiveTab = useStore((s) => s.setActiveTab);
  if (!parent) return null;

  const label = parent.text || 'Untitled task';
  const open = (e: React.MouseEvent) => {
    // Jump to the parent's board. Stops propagation so clicking the crumb doesn't also fire the
    // row's own "open this task" handler.
    e.stopPropagation();
    setActiveTab(parent.homeTabId);
  };

  if (variant === 'caption') {
    return (
      <button type="button" className="task-parent-caption" onClick={open} title={`Part of: ${label}`}>
        <span className="task-parent-arrow" aria-hidden>↳</span>
        <span className="task-parent-name">{label}</span>
      </button>
    );
  }
  return (
    <button type="button" className="task-parent-inline" onClick={open} title={`Part of: ${label}`}>
      <span className="task-parent-name">{label}</span>
      <span className="task-parent-sep" aria-hidden>›</span>
    </button>
  );
}
