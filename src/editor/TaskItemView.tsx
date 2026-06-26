import { useState, useEffect, useRef } from 'react';
import { NodeViewWrapper, NodeViewContent, type NodeViewProps } from '@tiptap/react';
import { useStore } from '../store';
import { Chip } from '../components/Chip';
import { DatePicker } from '../components/DatePicker';
import { formatDateChip } from '../util/dates';
import type { TaskStatus } from '../types';

const STATUS_ORDER: TaskStatus[] = ['todo', 'in_progress', 'in_review', 'done', 'cancelled'];
const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'Todo',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
  cancelled: 'Cancelled',
};

export function TaskItemView({ node }: NodeViewProps) {
  const id: string | null = node.attrs.id ?? null;

  const task = useStore((s) => (id ? s.tasks[id] : undefined));
  const project = useStore((s) => {
    if (!task) return undefined;
    const tab = s.tabs[task.homeTabId];
    return tab ? s.projects[tab.projectId] : undefined;
  });
  const members = useStore((s) => (task ? s.membersByBoard[task.homeTabId] : undefined));
  const toggleTaskDone = useStore((s) => s.toggleTaskDone);
  const setTaskStatus = useStore((s) => s.setTaskStatus);
  const setTaskMeta = useStore((s) => s.setTaskMeta);
  const [dateOpen, setDateOpen] = useState(false);

  const status: TaskStatus = task?.status ?? 'todo';
  const done = status === 'done';
  const cancelled = status === 'cancelled';

  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const toggle = () => {
    if (id) toggleTaskDone(id);
  };
  const pick = (s: TaskStatus) => {
    if (id) setTaskStatus(id, s);
    setMenuOpen(false);
  };

  // Resolve the assignee for display (email local-part); fall back to legacy free-text owner.
  const assignee = task?.assigneeId ? members?.find((m) => m.id === task.assigneeId) : undefined;
  const ownerLabel = assignee?.name ?? task?.owner;

  return (
    <NodeViewWrapper
      as="li"
      data-type="taskItem"
      data-id={id ?? undefined}
      data-status={status}
      className={`task-item status-${status} ${done || cancelled ? 'is-done' : ''} ${cancelled ? 'is-cancelled' : ''}`}
    >
      <div className="task-status" contentEditable={false} ref={rootRef}>
        <button
          type="button"
          className={`task-indicator status-${status}`}
          onClick={toggle}
          aria-label={done ? 'Mark not done' : 'Mark done'}
          style={project ? ({ '--accent': project.color } as React.CSSProperties) : undefined}
        >
          <span className="dot" />
          <svg viewBox="0 0 16 16" className="check" aria-hidden>
            <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          className="status-caret"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="Set status"
          aria-haspopup="listbox"
          aria-expanded={menuOpen}
        >
          <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden>
            <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {menuOpen && (
          <ul className="status-menu" role="listbox">
            {STATUS_ORDER.map((s) => (
              <li
                key={s}
                role="option"
                aria-selected={s === status}
                className={`status-option status-${s} ${s === status ? 'is-selected' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(s);
                }}
              >
                <span className="status-swatch" />
                {STATUS_LABEL[s]}
              </li>
            ))}
          </ul>
        )}
      </div>
      <NodeViewContent as="div" className="task-content" />
      <div className="task-chips" contentEditable={false}>
        {task?.priority ? (
          <Chip kind="priority" priority={task.priority}>{'!'.repeat(task.priority)}</Chip>
        ) : null}
        {ownerLabel ? <Chip kind="owner">{ownerLabel}</Chip> : null}
        {task?.date ? (
          <Chip kind="date" onClick={() => setDateOpen((v) => !v)}>{formatDateChip(task.date)}</Chip>
        ) : (
          <button type="button" className="chip chip-add-date" title="Set due date" onClick={() => setDateOpen((v) => !v)}>
            ＋date
          </button>
        )}
        {dateOpen && id ? (
          <DatePicker
            value={task?.date}
            onPick={(iso) => {
              setTaskMeta(id, { date: iso });
              setDateOpen(false);
            }}
            onClose={() => setDateOpen(false)}
          />
        ) : null}
      </div>
    </NodeViewWrapper>
  );
}
