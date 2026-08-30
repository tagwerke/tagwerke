import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { TaskActionMenu } from './common/TaskActionMenu';
import { extractDocText } from '../util/docText';

interface Hit {
  kind: 'tab' | 'task' | 'note';
  tabId: string;
  text: string;
  context?: string;
  /** Task hits only — lets the row carry the shared action menu. */
  taskId?: string;
}

/** A short excerpt around the match, so a hit against a long prose blob isn't the whole blob. */
function snippet(text: string, query: string): string {
  const idx = text.toLowerCase().indexOf(query);
  if (idx === -1) return text.slice(0, 90);
  const start = Math.max(0, idx - 30);
  const end = Math.min(text.length, idx + query.length + 60);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

export function SearchPalette({ onClose }: { onClose: () => void }) {
  const tabs = useStore((s) => s.tabs);
  const tasks = useStore((s) => s.tasks);
  const projects = useStore((s) => s.projects);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const [q, setQ] = useState('');
  const [menu, setMenu] = useState<{ taskId: string; tabId: string; x: number; y: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const hits = useMemo<Hit[]>(() => {
    const query = q.trim().toLowerCase();
    if (!query) return [];
    const out: Hit[] = [];
    for (const tab of Object.values(tabs)) {
      if (tab.name.toLowerCase().includes(query)) {
        out.push({ kind: 'tab', tabId: tab.id, text: tab.name, context: projects[tab.projectId]?.name });
      }
    }
    for (const t of Object.values(tasks)) {
      if (t.text.toLowerCase().includes(query)) {
        out.push({ kind: 'task', tabId: t.homeTabId, text: t.text, context: tabs[t.homeTabId]?.name, taskId: t.id });
      }
    }
    for (const tab of Object.values(tabs)) {
      const docText = extractDocText(tab.docJSON);
      if (docText.toLowerCase().includes(query)) {
        out.push({ kind: 'note', tabId: tab.id, text: snippet(docText, query), context: tab.name });
      }
    }
    return out.slice(0, 50);
  }, [q, tabs, tasks, projects]);

  const open = (hit: Hit) => {
    setActiveTab(hit.tabId);
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="search-palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder="search tabs and tasks"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && hits[0]) open(hits[0]);
          }}
        />
        <div className="search-results">
          {hits.length === 0 && q && <div className="search-empty">no matches</div>}
          {hits.map((h, i) => (
            // A row, not a bare button: a task hit carries its own "move to board" action, and a
            // button cannot legally contain another one. Finding a task by name and sending it
            // somewhere else without opening either board is the fastest path this app has for it.
            <div key={i} className="search-hit-row">
              <button className="search-hit" onClick={() => open(h)}>
                <span className={`search-kind ${h.kind}`}>{h.kind}</span>
                <span className="search-text">{h.text}</span>
                {h.context && <span className="search-context">{h.context}</span>}
              </button>
              {h.taskId && (
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Task actions"
                  title="Task actions"
                  onClick={(e) => {
                    const box = e.currentTarget.getBoundingClientRect();
                    setMenu({ taskId: h.taskId!, tabId: h.tabId, x: box.left, y: box.bottom + 4 });
                  }}
                >
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden>
                    <circle cx="3.5" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="12.5" cy="8" r="1.2" />
                  </svg>
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
      {menu && (
        <TaskActionMenu
          ids={[menu.taskId]}
          tabId={menu.tabId}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
