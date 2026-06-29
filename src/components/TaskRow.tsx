import { useState, useEffect, useRef } from 'react';
import { useStore } from '../store';
import { TaskMeta } from './TaskMeta';
import { propagateTaskText } from '../editor/registry';
import type { ID } from '../types';

interface Props { taskId: ID; blockId?: ID }

export function TaskRow({ taskId, blockId }: Props) {
  const task = useStore((s) => s.tasks[taskId]);
  const tabs = useStore((s) => s.tabs);
  const projects = useStore((s) => s.projects);
  const todayTabId = useStore((s) => s.todayTabId);
  const setTaskText = useStore((s) => s.setTaskText);
  const toggleTaskDone = useStore((s) => s.toggleTaskDone);
  const removeTaskFromBlock = useStore((s) => s.removeTaskFromBlock);
  const setActiveTab = useStore((s) => s.setActiveTab);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  if (!task) return null;
  const homeTab = tabs[task.homeTabId];
  const project = homeTab ? projects[homeTab.projectId] : undefined;

  // Status lives on the shared entity; toggling done just updates the store — no doc
  // write-back needed (both the list row and the editor read the same task).
  const onToggle = () => {
    toggleTaskDone(task.id);
  };

  const commit = () => {
    const newText = draft.trim();
    if (newText && newText !== task.text) {
      setTaskText(task.id, newText);
      // The row isn't a doc, so push the text to both spokes that hold this task.
      propagateTaskText(task.id, newText, '', [task.homeTabId, todayTabId]);
    }
    setEditing(false);
  };

  return (
    <li className={`task-row ${task.done ? 'is-done' : ''}`} style={project ? { '--row-accent': project.color } as React.CSSProperties : undefined}>
      <button
        type="button"
        className="task-indicator"
        onClick={onToggle}
        aria-label={task.done ? 'Mark not done' : 'Mark done'}
      >
        <span className="dot" />
        <svg viewBox="0 0 16 16" className="check" aria-hidden>
          <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div className="task-main">
        {editing ? (
          <input
            ref={inputRef}
            className="task-text-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              else if (e.key === 'Escape') { setDraft(task.text); setEditing(false); }
            }}
          />
        ) : (
          <button
            type="button"
            className="task-text"
            onClick={() => { setDraft(task.text); setEditing(true); }}
          >
            {task.text || <em className="muted">(empty)</em>}
          </button>
        )}
        <div className="task-row-meta">
          {homeTab && (
            <button className="task-row-source" onClick={() => setActiveTab(task.homeTabId)} title={`open ${homeTab.name}`}>
              <span className="dot" style={{ background: project?.color }} />
              {homeTab.name}
            </button>
          )}
          <TaskMeta taskId={task.id} />
        </div>
      </div>
      {blockId && (
        <button
          className="icon-btn remove"
          onClick={() => removeTaskFromBlock(blockId, task.id)}
          aria-label="remove from block"
          title="remove from block"
        >
          <svg viewBox="0 0 16 16" width="12" height="12"><path d="M4 4l8 8M12 4L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
        </button>
      )}
    </li>
  );
}
