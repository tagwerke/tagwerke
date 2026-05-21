import { NodeViewWrapper, NodeViewContent, type NodeViewProps } from '@tiptap/react';
import { useStore } from '../store';
import { Chip } from '../components/Chip';
import { formatDateChip } from '../util/dates';

export function TaskItemView({ node, editor, getPos }: NodeViewProps) {
  const id: string | null = node.attrs.id ?? null;
  const done: boolean = !!node.attrs.done;

  const task = useStore((s) => (id ? s.tasks[id] : undefined));
  const project = useStore((s) => {
    if (!task) return undefined;
    const tab = s.tabs[task.homeTabId];
    return tab ? s.projects[tab.projectId] : undefined;
  });

  const toggle = () => {
    const pos = typeof getPos === 'function' ? getPos() : null;
    if (pos == null) return;
    editor
      .chain()
      .command(({ tr }) => {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, done: !done });
        return true;
      })
      .focus()
      .run();
  };

  return (
    <NodeViewWrapper
      as="li"
      data-type="taskItem"
      data-id={id ?? undefined}
      data-done={done ? 'true' : 'false'}
      className={`task-item ${done ? 'is-done' : ''}`}
    >
      <button
        type="button"
        contentEditable={false}
        className="task-indicator"
        onClick={toggle}
        aria-label={done ? 'Mark not done' : 'Mark done'}
        style={project ? { '--accent': project.color } as React.CSSProperties : undefined}
      >
        <span className="dot" />
        <svg viewBox="0 0 16 16" className="check" aria-hidden>
          <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <NodeViewContent as="div" className="task-content" />
      <div className="task-chips" contentEditable={false}>
        {task?.priority ? (
          <Chip kind="priority" priority={task.priority}>{'!'.repeat(task.priority)}</Chip>
        ) : null}
        {task?.owner ? <Chip kind="owner">{task.owner}</Chip> : null}
        {task?.date ? <Chip kind="date">{formatDateChip(task.date)}</Chip> : null}
      </div>
    </NodeViewWrapper>
  );
}
