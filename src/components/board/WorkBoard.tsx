// The board (Kanban) layout of the work view (NOTES_SPLIT_PLAN §N2, §I.4).
//
// One column per group, so grouping by assignee gives a per-person board and grouping by sprint a
// sprint board — the same knob the table uses, laid out sideways.
//
// A drop writes ONLY the grouping field, which is what the Kanban has always done. It deliberately
// does not reorder: a column renders in outline order (a tree walk), so "between these two cards"
// is not a rankBetween of two siblings the moment a sub-task is on screen. Reordering lives in the
// table, where the order is a flat rank list and the question is well posed.

import { useState } from 'react';
import { SubtaskProgress } from '../common/SubtaskProgress';
import { TaskParentPath } from '../common/TaskParentPath';
import { QuickAdd } from '../common/QuickAdd';
import type { DraftFields } from '../../tasks/createTask';
import type { FocusField } from '../../tasks/actions';
import type { Group } from './workView';
import type { ID } from '../../types';

export function WorkBoard({ tabId, groups, onDropOn, onOpenTask, onOpenMenu, addFieldsFor, editable }: {
  tabId: ID;
  groups: Group[];
  /** Move a task into this group — sets whichever field the board is grouped by. */
  onDropOn: (taskId: ID, groupKey: string) => void;
  onOpenTask: (id: ID) => void;
  onOpenMenu: (ids: ID[], x: number, y: number, field?: FocusField) => void;
  /** What a task added in this column should start with, or null where that is not expressible. */
  addFieldsFor: (groupKey: string) => DraftFields | null;
  editable: boolean;
}) {
  const [over, setOver] = useState<string | null>(null);

  return (
    <div className="work-board">
      {groups.map((g) => {
        const add = addFieldsFor(g.key);
        return (
          <section
            key={g.key}
            className={`wb-col ${over === g.key ? 'is-over' : ''}`}
            onDragOver={(e) => { if (editable) { e.preventDefault(); setOver(g.key); } }}
            onDragLeave={() => setOver((k) => (k === g.key ? null : k))}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const id = e.dataTransfer.getData('text/task');
              if (id && editable) onDropOn(id, g.key);
            }}
          >
            <header className="wb-col-head">
              {g.swatch && <span className={`list-dot ${g.swatch}`} />}
              <span className="wb-col-name">{g.label}</span>
              <span className="wb-col-n">{g.tasks.length}</span>
            </header>

            <div className="wb-col-stack">
              {/* Per column, so a task added here starts in this column (§I.1). Grouping the board
                  by something a new task cannot be born with — a sprint it is not in yet — simply
                  offers no line rather than one that would put the card somewhere else. */}
              {editable && add && <QuickAdd tabId={tabId} presetFields={add} placeholder="Add a task" />}

              {g.tasks.map((t) => (
                <article
                  key={t.id}
                  className={`task-card ${t.parentTaskId ? 'is-subtask' : ''}`}
                  draggable={editable}
                  onDragStart={(e) => e.dataTransfer.setData('text/task', t.id)}
                  onClick={() => onOpenTask(t.id)}
                  onContextMenu={(e) => { e.preventDefault(); onOpenMenu([t.id], e.clientX, e.clientY); }}
                >
                  {/* Columns split a family apart, so a card has to say what it is part of. */}
                  <TaskParentPath taskId={t.id} variant="caption" />
                  <div className="task-card-text">{t.text || <em className="muted">(empty)</em>}</div>
                  <SubtaskProgress taskId={t.id} className="on-card" />
                </article>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
