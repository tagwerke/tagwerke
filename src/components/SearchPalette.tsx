import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';

interface Hit {
  kind: 'tab' | 'task';
  tabId: string;
  text: string;
  context?: string;
}

export function SearchPalette({ onClose }: { onClose: () => void }) {
  const tabs = useStore((s) => s.tabs);
  const tasks = useStore((s) => s.tasks);
  const projects = useStore((s) => s.projects);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const [q, setQ] = useState('');

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
        out.push({ kind: 'task', tabId: t.homeTabId, text: t.text, context: tabs[t.homeTabId]?.name });
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
            <button key={i} className="search-hit" onClick={() => open(h)}>
              <span className={`search-kind ${h.kind}`}>{h.kind}</span>
              <span className="search-text">{h.text}</span>
              {h.context && <span className="search-context">{h.context}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
