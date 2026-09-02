// How a task mention looks inside a note (NOTES_SPLIT_PLAN §N4).
//
// Live title from the store, so renaming a task updates every note that mentions it. Read-only:
// it displays and it navigates, and that is the entire contract. No status control, no checkbox,
// no drag handle — a note does not manage work, it points at it.
//
// A mention whose task is gone renders as a tombstone rather than disappearing: the sentence was
// written about something, and silently swallowing the reference would leave prose that no longer
// makes sense with nothing to say why.

import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { useStore } from '../store';
import { boardTaskPath, navigate } from '../util/router';
import type { ID } from '../types';

export function TaskMentionView({ node }: ReactNodeViewProps) {
  const id = (node.attrs.id as ID | null) ?? null;
  const task = useStore((s) => (id ? s.tasks[id] : undefined));

  if (!id) return null;

  if (!task) {
    return (
      <NodeViewWrapper as="span" className="task-mention is-gone" contentEditable={false}>
        <span className="task-mention-text">deleted task</span>
      </NodeViewWrapper>
    );
  }

  const status = task.status ?? 'todo';
  const done = status === 'done' || status === 'cancelled';

  return (
    <NodeViewWrapper as="span" className={`task-mention ${done ? 'is-done' : ''}`} contentEditable={false}>
      <button
        type="button"
        className="task-mention-btn"
        title={`Open — ${task.text || 'untitled task'}`}
        onClick={() => navigate(boardTaskPath(task.homeTabId, task.id))}
      >
        <span className={`list-dot status-${status}`} />
        <span className="task-mention-text">{task.text || 'untitled task'}</span>
        <svg viewBox="0 0 16 16" width="9" height="9" aria-hidden>
          <path d="M6 3h7v7M13 3L4 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </NodeViewWrapper>
  );
}
