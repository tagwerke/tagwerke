import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import type { ID } from '../types';

interface Props {
  tabId: ID;
  excludeIds: Set<ID>;
  onPick: (taskId: ID) => void;
  onClose: () => void;
}

export function TaskPicker({ tabId, excludeIds, onPick, onClose }: Props) {
  const tasks = useStore((s) => s.tasks);
  const tab = useStore((s) => s.tabs[tabId]);
  const [q, setQ] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    return Object.values(tasks)
      .filter((t) => t.homeTabId === tabId)
      .filter((t) => !excludeIds.has(t.id))
      .filter((t) => !query || t.text.toLowerCase().includes(query))
      .sort((a, b) => (a.done === b.done ? 0 : a.done ? 1 : -1));
  }, [tasks, tabId, excludeIds, q]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="picker" onMouseDown={(e) => e.stopPropagation()}>
        <h3>pick task from {tab?.name ?? '?'}</h3>
        <input
          autoFocus
          placeholder="filter…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <ul className="picker-list">
          {filtered.length === 0 && <li className="picker-empty">no tasks left in this tab.</li>}
          {filtered.map((t) => (
            <li key={t.id}>
              <button className="picker-item" onClick={() => { onPick(t.id); onClose(); }}>
                <span className={`picker-dot ${t.done ? 'done' : ''}`} />
                <span>{t.text}</span>
                {t.priority && <span className={`chip chip-priority p${t.priority}`}>{'!'.repeat(t.priority)}</span>}
                {t.date && <span className="chip chip-date">{t.date}</span>}
              </button>
            </li>
          ))}
        </ul>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>close</button>
        </div>
      </div>
    </div>
  );
}
