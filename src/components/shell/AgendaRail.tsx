// The persistent day agenda, dissolved out of the old full-screen Planner into the sidebar.
// Shows TODAY's own time blocks (each references a board), sorted by start time. Every row
// opens its board — fixing the old "can't jump to your own block" gap. "+ block" targets the
// board you're currently in (or the first board), not a hardcoded first tab.

import { useCallback, useEffect } from 'react';
import { useStore } from '../../store';
import { useSession } from '../../session/useSession';
import { api, drain, type TimeBlockOut } from '../../api/client';
import { toISO, formatDateChip } from '../../util/dates';
import type { BlockFilter, TimeBlock } from '../../types';

function toBlock(o: TimeBlockOut): TimeBlock {
  return { ...o, filter: (o.filter as BlockFilter | null) ?? null };
}

/** Sort key: timed blocks first (by start), untimed last, ties by position. */
function order(a: TimeBlock, b: TimeBlock): number {
  const as = a.start ?? '99:99';
  const bs = b.start ?? '99:99';
  return as < bs ? -1 : as > bs ? 1 : a.position - b.position;
}

export function AgendaRail() {
  const me = useSession((s) => s.user);
  const ownBlocks = useStore((s) => s.timeBlocks);
  const setOwnTimeBlocks = useStore((s) => s.setOwnTimeBlocks);
  const createTimeBlock = useStore((s) => s.createTimeBlock);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const tabs = useStore((s) => s.tabs);
  const projects = useStore((s) => s.projects);
  const tabOrder = useStore((s) => s.tabOrder);
  const activeTabId = useStore((s) => s.activeTabId);

  const today = toISO(new Date());

  const refresh = useCallback(async () => {
    if (!me) return;
    try {
      await drain();
      const { blocks } = await api.timeBlocks.list(today, today);
      setOwnTimeBlocks(blocks.filter((b) => b.userId === me.id).map(toBlock));
    } catch {
      // Offline: keep whatever blocks are already in the store.
    }
  }, [me, today, setOwnTimeBlocks]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const blocks = Object.values(ownBlocks).filter((b) => b.date === today).sort(order);
  const targetTab = activeTabId ?? tabOrder.find((id) => tabs[id]?.type === 'normal');

  return (
    <div className="agenda-rail">
      <div className="agenda-head">
        <span className="agenda-title">Today</span>
        <span className="agenda-date">{formatDateChip(today)}</span>
      </div>
      <div className="agenda-list">
        {blocks.length === 0 && <p className="agenda-empty muted">Nothing scheduled.</p>}
        {blocks.map((b) => {
          const tab = tabs[b.tabId];
          const project = tab ? projects[tab.projectId] : undefined;
          return (
            <button
              key={b.id}
              className="agenda-item"
              onClick={() => setActiveTab(b.tabId)}
              style={project ? ({ '--accent': project.color } as React.CSSProperties) : undefined}
            >
              <span className="agenda-time">{b.start ?? '—'}</span>
              <span className="agenda-body">
                <span className="agenda-name">{b.label || tab?.name || 'untitled'}</span>
                {tab && (
                  <span className="agenda-board">{project ? `${project.name} · ${tab.name}` : tab.name}</span>
                )}
              </span>
            </button>
          );
        })}
        <button
          className="agenda-add"
          disabled={!targetTab || !me}
          onClick={() => me && targetTab && createTimeBlock({ userId: me.id, tabId: targetTab, date: today })}
        >
          + block
        </button>
      </div>
    </div>
  );
}
