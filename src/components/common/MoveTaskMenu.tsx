// "Move to board…" — the trailing action that takes a task, and the work under it, somewhere else.
//
// A command rather than a drag, for three reasons: there is no board list on screen while a board
// is open (so there would be nothing to drag ONTO), HTML5 drag events don't fire on touch, and a
// keyboard user needs a way in. Dragging inside a board (reorder / re-nest) is a separate thing and
// lives in src/editor/taskDnd.ts.
//
// Rendered by every surface that shows a task row — the doc lines, the Kanban card, the list row —
// so the affordance is in the same place whatever view you happen to be in.

import { useEffect, useMemo, useRef, useState } from 'react';
import { descendantsOf, useStore } from '../../store';
import { moveTaskToBoard, moveTargets, describeMove } from '../../tasks/moveToBoard';
import { showToast } from '../../toast/useToast';
import type { ID } from '../../types';

export function MoveTaskMenu({ taskId, className = '' }: { taskId: ID; className?: string }) {
  const task = useStore((s) => s.tasks[taskId]);
  const tasks = useStore((s) => s.tasks);
  const projects = useStore((s) => s.projects);
  const tabs = useStore((s) => s.tabs);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [activeRaw, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  // Derived from `tabs` (rather than snapshotted when the menu opens) so a board shared with you
  // mid-session, or renamed, is in the list without reopening.
  const targets = useMemo(() => moveTargets(tabs, task?.homeTabId), [tabs, task?.homeTabId]);
  const hits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? targets.filter((t) => t.name.toLowerCase().includes(needle)) : targets;
  }, [targets, q]);
  // Clamped rather than reset by an effect: filtering the list can strand the highlight past its
  // end, and correcting that during render costs one comparison instead of a second render pass.
  const active = Math.min(activeRaw, Math.max(0, hits.length - 1));

  const subtaskCount = useMemo(() => (task ? descendantsOf(tasks, taskId).length : 0), [tasks, taskId, task]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!task) return null;

  const pick = async (toTabId: ID): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await moveTaskToBoard(taskId, toTabId);
      setOpen(false);
      showToast(describeMove(result, tabs[toTabId]?.name ?? 'that board'));
    } catch {
      // The move is a live call by design (see moveToBoard.ts) — offline, or a board we may not
      // write to, both land here. Say so rather than leaving the menu looking stuck.
      showToast('Could not move the task — you need to be online, and an editor on both boards.');
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(hits.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const t = hits[active];
      if (t) void pick(t.id);
    }
  };

  return (
    <span className="move-menu-wrap" ref={rootRef} contentEditable={false}>
      <button
        type="button"
        className={`icon-btn task-move-btn ${className}`}
        // The Kanban card that hosts this is itself draggable; without this, pressing the button
        // starts a card drag instead of opening the menu.
        draggable={false}
        title="Move to another board"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setQ(''); setActive(0); setOpen((v) => !v); }}
      >
        {/* An arrow going into a container: "send this somewhere else". The earlier folder-with-an
            arrow-inside had too much detail to survive at 14px — the strokes merged and it read as
            a smudge next to the plain clock beside it. Three strokes, full-height, no interior. */}
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9.5 3.2h3.3v9.6H9.5" />
          <path d="M2.6 8h6.2" />
          <path d="M6.3 5.5 8.8 8l-2.5 2.5" />
        </svg>
      </button>

      {open && (
        <div className="move-menu" role="menu" onKeyDown={onKeyDown}>
          <div className="move-menu-head">
            Move to board
            {/* Sub-tasks travel with their parent — stated up front, because it is the part of this
                command that does more than the label says. */}
            {subtaskCount > 0 && (
              <span className="move-menu-note">
                takes {subtaskCount} sub-task{subtaskCount === 1 ? '' : 's'} with it
              </span>
            )}
          </div>
          <input
            autoFocus
            className="move-menu-search"
            placeholder="Find a board…"
            value={q}
            onChange={(e) => { setQ(e.target.value); setActive(0); }}
          />
          <div className="move-menu-list">
            {hits.length === 0 && (
              <div className="move-menu-empty muted">
                {targets.length === 0 ? 'No other board you can edit.' : 'No board matches.'}
              </div>
            )}
            {hits.map((t, i) => (
              <button
                key={t.id}
                type="button"
                role="menuitem"
                disabled={busy}
                className={`move-menu-item ${i === active ? 'is-active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => void pick(t.id)}
              >
                <span className="move-menu-dot" style={{ background: projects[t.projectId]?.color ?? 'var(--ink-mute)' }} />
                <span className="move-menu-name">{t.name}</span>
                {projects[t.projectId] && <span className="move-menu-space">{projects[t.projectId].name}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </span>
  );
}
