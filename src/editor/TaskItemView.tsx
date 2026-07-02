import { useState } from 'react';
import { NodeViewWrapper, NodeViewContent, type NodeViewProps } from '@tiptap/react';
import { useStore } from '../store';
import { TaskMeta } from '../components/TaskMeta';
import { StatusControl } from '../components/StatusControl';
import { HistoryDrawer } from '../components/HistoryDrawer';
import type { TaskStatus } from '../types';

export function TaskItemView({ node }: NodeViewProps) {
  const id: string | null = node.attrs.id ?? null;

  const task = useStore((s) => (id ? s.tasks[id] : undefined));
  const project = useStore((s) => {
    if (!task) return undefined;
    const tab = s.tabs[task.homeTabId];
    return tab ? s.projects[tab.projectId] : undefined;
  });
  const toggleTaskDone = useStore((s) => s.toggleTaskDone);
  const setTaskStatus = useStore((s) => s.setTaskStatus);
  const [historyOpen, setHistoryOpen] = useState(false);

  const status: TaskStatus = task?.status ?? 'todo';
  const done = status === 'done';
  const cancelled = status === 'cancelled';

  return (
    <NodeViewWrapper
      as="li"
      data-type="taskItem"
      data-id={id ?? undefined}
      data-status={status}
      className={`task-item status-${status} ${done || cancelled ? 'is-done' : ''} ${cancelled ? 'is-cancelled' : ''}`}
    >
      <StatusControl
        status={status}
        accentColor={project?.color}
        onToggle={() => { if (id) toggleTaskDone(id); }}
        onPick={(s) => { if (id) setTaskStatus(id, s); }}
      />
      <NodeViewContent as="div" className="task-content" />
      {id ? <TaskMeta taskId={id} /> : null}
      {/* History is reachable on EVERY task (even with no metadata) — a quiet trailing action
          revealed on row hover. See AUDIT_IMPLEMENTATION_PLAN §I. */}
      {id && task ? (
        <button
          type="button"
          className="icon-btn task-history-btn"
          contentEditable={false}
          title="View history"
          onClick={() => setHistoryOpen(true)}
        >
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
            <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M8 4.6V8l2.4 1.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      ) : null}
      {historyOpen && id && task ? (
        <HistoryDrawer kind="task" id={id} boardId={task.homeTabId} title={task.text || 'task'} onClose={() => setHistoryOpen(false)} />
      ) : null}
    </NodeViewWrapper>
  );
}
