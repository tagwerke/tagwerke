import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import type { ID, Task } from '../types';

interface Props {
  tabId: ID;
  excludeIds: Set<ID>;
  onPickExisting: (taskId: ID) => void;
  onCreateNew: (rawText: string) => void;
  onCancel: () => void;
  placeholder?: string;
}

type Item =
  | { kind: 'existing'; task: Task }
  | { kind: 'create'; text: string };

const MAX_SUGGESTIONS = 8;

export function TaskAutocomplete({
  tabId,
  excludeIds,
  onPickExisting,
  onCreateNew,
  onCancel,
  placeholder,
}: Props) {
  const tasks = useStore((s) => s.tasks);
  const [text, setText] = useState('');
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const existing = useMemo<Task[]>(() => {
    if (!tabId) return [];
    const query = text.trim().toLowerCase();
    return Object.values(tasks)
      .filter((t) => t.homeTabId === tabId && !excludeIds.has(t.id))
      .filter((t) => !query || t.text.toLowerCase().includes(query))
      .sort((a, b) => (a.done === b.done ? 0 : a.done ? 1 : -1))
      .slice(0, MAX_SUGGESTIONS);
  }, [tasks, tabId, excludeIds, text]);

  const items: Item[] = useMemo(() => {
    const out: Item[] = existing.map((task) => ({ kind: 'existing' as const, task }));
    const trimmed = text.trim();
    if (trimmed) out.push({ kind: 'create', text: trimmed });
    return out;
  }, [existing, text]);

  useEffect(() => {
    setHighlight((h) => (items.length === 0 ? 0 : Math.min(h, items.length - 1)));
  }, [items.length]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const commit = () => {
    const item = items[highlight];
    if (!item) {
      if (text.trim()) onCreateNew(text.trim());
      return;
    }
    if (item.kind === 'existing') onPickExisting(item.task.id);
    else onCreateNew(item.text);
  };

  return (
    <div className="task-autocomplete">
      <input
        ref={inputRef}
        className="task-autocomplete-input"
        value={text}
        placeholder={placeholder ?? 'task — type to filter or create'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlight((h) => Math.min(items.length - 1, h + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlight((h) => Math.max(0, h - 1));
          }
        }}
      />
      {items.length > 0 && (
        <ul className="task-autocomplete-list" ref={listRef}>
          {items.map((item, i) => (
            <li key={item.kind === 'existing' ? item.task.id : '__create__'}>
              <button
                type="button"
                className={`task-autocomplete-item ${i === highlight ? 'active' : ''} ${item.kind}`}
                onMouseEnter={() => setHighlight(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={commit}
              >
                {item.kind === 'existing' ? (
                  <>
                    <span className={`picker-dot ${item.task.done ? 'done' : ''}`} />
                    <span className="task-autocomplete-text">{item.task.text || <em>(empty)</em>}</span>
                    {item.task.priority && (
                      <span className={`chip chip-priority p${item.task.priority}`}>
                        {'!'.repeat(item.task.priority)}
                      </span>
                    )}
                    {item.task.date && <span className="chip chip-date">{item.task.date}</span>}
                  </>
                ) : (
                  <>
                    <span className="task-autocomplete-plus">+</span>
                    <span className="task-autocomplete-text">
                      Create new: <em>"{item.text}"</em>
                    </span>
                  </>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
