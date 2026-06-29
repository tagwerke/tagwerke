import { NodeViewWrapper, NodeViewContent, type NodeViewProps } from '@tiptap/react';
import { useStore } from '../store';
import { TaskMeta } from '../components/TaskMeta';
import { StatusControl } from '../components/StatusControl';
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
    </NodeViewWrapper>
  );
}
