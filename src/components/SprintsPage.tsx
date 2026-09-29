// The board's sprint list (SPRINTS_PLAN.md): every sprint (past, current, future) plus a
// synthesized Backlog row, with the management actions — rename, make current/inactive,
// delete — that used to be scattered across a toolbar stepper. This IS the management
// surface, not a popover off one; clicking a row drills into List pre-filtered to it.

import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { askConfirm } from '../confirm/useConfirm';
import type { ID, Sprint } from '../types';

export function SprintsPage({ tabId, onOpenSprint }: { tabId: string; onOpenSprint: (sprintId: ID | null) => void }) {
  const sprints = useStore((s) => s.sprintsByBoard[tabId]) ?? [];
  const tasks = useStore((s) => s.tasks);
  const role = useStore((s) => s.tabs[tabId]?.role);
  const renameSprint = useStore((s) => s.renameSprint);
  const setSprintCurrent = useStore((s) => s.setSprintCurrent);
  const removeSprint = useStore((s) => s.removeSprint);
  const [editing, setEditing] = useState<ID | null>(null);
  const [draft, setDraft] = useState('');
  const [menuFor, setMenuFor] = useState<ID | null>(null);
  const canManage = role === 'editor' || role === 'admin';
  const canDelete = role === 'admin';

  // Oldest first, the order the sprint filter, the pickers and group-by-sprint all use.
  const ordered = useMemo(() => [...sprints].sort((a, b) => (a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : 0)), [sprints]);

  const countFor = (sprintId: ID | null) =>
    Object.values(tasks).filter((t) => t.homeTabId === tabId && (t.sprintId ?? null) === sprintId).length;

  const startEdit = (sprint: Sprint) => {
    setEditing(sprint.id);
    setDraft(sprint.label);
  };
  const commitEdit = () => {
    if (editing && draft.trim()) renameSprint(editing, draft.trim());
    setEditing(null);
  };

  async function onDelete(sprint: Sprint) {
    const n = countFor(sprint.id);
    const ok = await askConfirm({
      title: `Delete “${sprint.label}”?`,
      body: n > 0 ? `${n} task${n === 1 ? '' : 's'} in it will move to the backlog.` : 'This sprint has no tasks in it.',
      confirmLabel: 'Delete sprint',
    });
    if (ok) removeSprint(sprint.id);
  }

  return (
    <div className="sprints-page">
      <p className="sprints-note muted">
        A new sprint starts every Monday, and anything unfinished in the current one moves into it.
      </p>

      <ul className="sprints-list">
        {ordered.map((sprint) => {
          const n = countFor(sprint.id);
          const open = menuFor === sprint.id;
          return (
          <li key={sprint.id} className={`sprints-row ${sprint.isCurrent ? 'is-current' : ''}`}>
            <div className="sprints-row-main">
              <button
                type="button"
                className="sprints-current-toggle"
                disabled={!canManage}
                title={sprint.isCurrent ? 'Current sprint — click to unset' : 'Make this the current sprint'}
                aria-label={sprint.isCurrent ? 'unset as current sprint' : 'set as current sprint'}
                aria-pressed={sprint.isCurrent}
                onClick={() => setSprintCurrent(tabId, sprint.id, !sprint.isCurrent)}
              >
                <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
                  <path
                    d="M8 1.7l1.9 4 4.4.5-3.3 3 .9 4.3L8 11.6l-3.9 1.9.9-4.3-3.3-3 4.4-.5z"
                    fill={sprint.isCurrent ? 'currentColor' : 'none'}
                    stroke="currentColor"
                    strokeWidth="1.2"
                  />
                </svg>
              </button>

              {editing === sprint.id ? (
                <input
                  className="sprints-row-label-input"
                  value={draft}
                  autoFocus
                  aria-label="Sprint name"
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitEdit();
                    if (e.key === 'Escape') setEditing(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="sprints-row-label"
                  title={`Show ${sprint.label} on the board`}
                  onClick={() => onOpenSprint(sprint.id)}
                >
                  {sprint.label}
                </button>
              )}

              <span className="sprints-row-count" title={`${n} task${n === 1 ? '' : 's'}`}>{n}</span>

              {/* Rename and Delete used to sit in the row itself, which is wider than this rail;
                  they fold under the row instead. The toggle stays visible — an affordance that
                  only shows on hover is one nobody finds (COMMENTS_PLAN §8). */}
              {canManage && editing !== sprint.id && (
                <button
                  type="button"
                  className={`sprints-row-more ${open ? 'is-open' : ''}`}
                  aria-label={`More for ${sprint.label}`}
                  aria-expanded={open}
                  onClick={() => setMenuFor(open ? null : sprint.id)}
                >
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
                    <circle cx="3.5" cy="8" r="1.3" fill="currentColor" />
                    <circle cx="8" cy="8" r="1.3" fill="currentColor" />
                    <circle cx="12.5" cy="8" r="1.3" fill="currentColor" />
                  </svg>
                </button>
              )}
            </div>

            {open && editing !== sprint.id && (
              <div className="sprints-row-actions">
                <button type="button" className="btn ghost tiny" onClick={() => { setMenuFor(null); startEdit(sprint); }}>
                  Rename
                </button>
                {canDelete && (
                  <button type="button" className="btn ghost tiny sprints-row-delete" onClick={() => { setMenuFor(null); void onDelete(sprint); }}>
                    Delete
                  </button>
                )}
              </div>
            )}
          </li>
          );
        })}

        {(() => {
          const n = countFor(null);
          return (
            <li className="sprints-row sprints-row-backlog">
              <div className="sprints-row-main">
                <span className="sprints-current-toggle" aria-hidden />
                <button type="button" className="sprints-row-label" title="Show the backlog on the board" onClick={() => onOpenSprint(null)}>
                  Backlog
                </button>
                <span className="sprints-row-count" title={`${n} task${n === 1 ? '' : 's'}`}>{n}</span>
                {canManage && <span className="sprints-row-more" aria-hidden />}
              </div>
            </li>
          );
        })()}
      </ul>
    </div>
  );
}
