// One time block: a reference to a tab (board) + an optional projection filter, showing
// that tab's LIVE tasks. Own blocks are editable (retarget tab, set times, filter,
// delete); teammates' blocks render read-only.

import { useMemo, useState } from 'react';
import { useStore, useTasksForTab } from '../../store';
import { rankTabs } from '../../util/header';
import { matchesBlockFilter } from '../../util/filter';
import { Dropdown, type DropdownOption } from '../Dropdown';
import { STATUS_ORDER, STATUS_LABEL } from '../StatusControl';
import { PlannerTaskLine } from './PlannerTaskLine';
import type { BlockFilter, TaskStatus, TimeBlock } from '../../types';

const MAX_LINES = 12;

export function TimeBlockCard({ block, readOnly, ownerLabel }: { block: TimeBlock; readOnly?: boolean; ownerLabel?: string }) {
  const tabs = useStore((s) => s.tabs);
  const projects = useStore((s) => s.projects);
  const tabOrder = useStore((s) => s.tabOrder);
  const updateTimeBlock = useStore((s) => s.updateTimeBlock);
  const deleteTimeBlock = useStore((s) => s.deleteTimeBlock);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const setPlannerOpen = useStore((s) => s.setPlannerOpen);

  const [filterOpen, setFilterOpen] = useState(false);

  const tab = tabs[block.tabId];
  const project = tab ? projects[tab.projectId] : undefined;

  const tabOptions: DropdownOption[] = useMemo(
    () => rankTabs('', tabs, projects, tabOrder).map((m) => ({
      value: m.tabId,
      label: m.projectName ? `${m.projectName} · ${m.name}` : m.name,
      accent: m.projectColor,
    })),
    [tabs, projects, tabOrder],
  );

  const allTasks = useTasksForTab(block.tabId);
  const tasks = useMemo(
    () => allTasks.filter((t) => matchesBlockFilter(t, block.filter)).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
    [allTasks, block.filter],
  );

  const openTab = () => { setPlannerOpen(false); setActiveTab(block.tabId); };

  const toggleStatusFilter = (s: TaskStatus) => {
    const cur = block.filter?.statuses ?? [];
    const next = cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s];
    const filter: BlockFilter = { ...block.filter, statuses: next.length ? next : undefined };
    updateTimeBlock(block.id, { filter });
  };

  const activeStatusFilter = block.filter?.statuses ?? [];

  return (
    <article className="time-block" style={project ? ({ '--accent': project.color } as React.CSSProperties) : undefined}>
      <header className="time-block-head">
        <span className="time-block-dot" style={{ background: project?.color }} />
        {readOnly ? (
          <button className="time-block-title" onClick={openTab} title={`open ${tab?.name ?? ''}`}>
            {tab ? (project ? `${project.name} · ${tab.name}` : tab.name) : 'untitled'}
          </button>
        ) : (
          <div className="time-block-picker">
            <Dropdown value={block.tabId} options={tabOptions} onChange={(v) => updateTimeBlock(block.id, { tabId: v })} placeholder="pick a tab…" />
          </div>
        )}
        {ownerLabel && <span className="time-block-owner">{ownerLabel.split('@')[0]}</span>}
        {!readOnly && (
          <button className="icon-btn delete" onClick={() => deleteTimeBlock(block.id)} aria-label="delete block" title="delete block">
            <svg viewBox="0 0 16 16" width="12" height="12"><path d="M4 4l8 8M12 4L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
          </button>
        )}
      </header>

      <div className="time-block-controls">
        {readOnly ? (
          <span className="time-block-when">{block.start ?? '—'}{block.end ? `–${block.end}` : ''}</span>
        ) : (
          <>
            <input type="time" className="time-block-time" value={block.start ?? ''} onChange={(e) => updateTimeBlock(block.id, { start: e.target.value || null })} aria-label="start time" />
            <span className="time-block-dash">–</span>
            <input type="time" className="time-block-time" value={block.end ?? ''} onChange={(e) => updateTimeBlock(block.id, { end: e.target.value || null })} aria-label="end time" />
            <button className={`btn ghost tiny ${activeStatusFilter.length ? 'has-filter' : ''}`} onClick={() => setFilterOpen((v) => !v)} title="filter the projected tasks">
              filter{activeStatusFilter.length ? ` · ${activeStatusFilter.length}` : ''}
            </button>
          </>
        )}
      </div>

      {filterOpen && !readOnly && (
        <div className="time-block-filter">
          {STATUS_ORDER.map((s) => (
            <button
              key={s}
              className={`status-chip status-${s} ${activeStatusFilter.includes(s) ? 'on' : ''}`}
              onClick={() => toggleStatusFilter(s)}
            >{STATUS_LABEL[s]}</button>
          ))}
        </div>
      )}

      <ul className="time-block-tasks">
        {tasks.length === 0 && <li className="time-block-empty muted">no matching tasks</li>}
        {tasks.slice(0, MAX_LINES).map((t) => <PlannerTaskLine key={t.id} taskId={t.id} readOnly={readOnly} />)}
        {tasks.length > MAX_LINES && (
          <li className="time-block-more"><button className="link-btn" onClick={openTab}>+{tasks.length - MAX_LINES} more →</button></li>
        )}
      </ul>
    </article>
  );
}
