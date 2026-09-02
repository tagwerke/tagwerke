// The add line: a title, and nothing else.
//
// It used to carry the document's `/` and `@` popup, because typing was the only way to set a
// field on a task being created. It is not any more — every cell in the table opens the shared
// action menu, by click or by keyboard — so the popup was a second way to do one thing, and the
// second way is the one that goes. What is left is a field you type a name into.
//
// Nesting stays, because that is structure rather than a field, and Tab is the gesture people
// brought from the document: Tab nests the next task under the one just added, Shift+Tab steps
// back out, and the line names the parent it is about to write under so the state is never
// invisible.

import { useEffect, useRef, useState } from 'react';
import { ancestorsOf, useStore } from '../../store';
import { createTaskInBoard, type DraftFields } from '../../tasks/createTask';
import { registerQuickAdd } from '../../tasks/quickAddFocus';
import { MAX_TASK_DEPTH } from '../../../shared/tree';
import type { ID } from '../../types';

export function QuickAdd({ tabId, parentTaskId, presetFields, placeholder, shortcut, onCreated }: {
  tabId: ID;
  /** Nest what gets created under this task. */
  parentTaskId?: ID;
  /** Fields the surface itself implies — a Kanban column supplies its own status. */
  presetFields?: DraftFields;
  placeholder?: string;
  /** Bind the board-level `n` shortcut to this line. Exactly one per screen. */
  shortcut?: boolean;
  onCreated?: (id: ID) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [nestUnder, setNestUnder] = useState<ID | null>(null);
  const lastCreated = useRef<ID | null>(null);
  const role = useStore((s) => s.tabs[tabId]?.role);
  const canEdit = role !== 'viewer';
  const parentTitle = useStore((s) => (nestUnder ? s.tasks[nestUnder]?.text : undefined));

  useEffect(() => {
    const unregister = shortcut ? registerQuickAdd(tabId, () => inputRef.current?.focus()) : undefined;
    if (!shortcut) return unregister;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'n' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement;
      // Never steal the key from something already taking text.
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return;
      if (el instanceof HTMLElement && el.isContentEditable) return;
      // Nor from the table: with a cursor on a title, a letter starts a rename, and the table is
      // neither an input nor contentEditable so the checks above miss it (§T2.3).
      if (el instanceof HTMLElement && el.closest('.work-table')) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      unregister?.();
    };
  }, [shortcut, tabId]);

  if (!canEdit) return null;

  /** Tab: one level deeper, under whatever was added last. Refused at the depth limit. */
  const nestDeeper = (): void => {
    const anchor = nestUnder ? lastCreated.current ?? nestUnder : lastCreated.current;
    if (!anchor) return;
    if (ancestorsOf(useStore.getState().tasks, anchor).length + 1 >= MAX_TASK_DEPTH) return;
    setNestUnder(anchor);
  };

  /** Shift+Tab: back out one level, to the current parent's own parent. */
  const nestShallower = (): void => {
    if (!nestUnder) return;
    setNestUnder(useStore.getState().tasks[nestUnder]?.parentTaskId ?? null);
  };

  const submit = (openAfter: boolean): void => {
    const text = value.trim();
    if (!text) return;

    const id = createTaskInBoard(tabId, {
      text,
      // An explicit prop wins — a Kanban column's line is never nesting anything.
      parentTaskId: parentTaskId ?? nestUnder ?? undefined,
      fields: presetFields,
    });

    lastCreated.current = id;
    setValue('');
    if (openAfter) useStore.getState().setOpenTask(id);
    else inputRef.current?.focus(); // stay put for the next one
    onCreated?.(id);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Tab' && !parentTaskId) {
      e.preventDefault();
      return e.shiftKey ? nestShallower() : nestDeeper();
    }
    if (e.key === 'Enter') { e.preventDefault(); return submit(e.shiftKey); }
    if (e.key === 'Escape') {
      e.preventDefault();
      setValue('');
      setNestUnder(null);
      inputRef.current?.blur();
    }
    // Arrows belong to the table's cursor, not to a one-line field.
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') return;
    e.stopPropagation();
  };

  return (
    <div className="quick-add">
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
        <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      {nestUnder && (
        <span className="quick-add-under" title="Shift+Tab to step back out">
          <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden>
            <path d="M4 3v6h8M9 6l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {parentTitle || 'task'}
        </span>
      )}
      <input
        ref={inputRef}
        className="quick-add-input"
        value={value}
        placeholder={nestUnder ? 'Sub-task' : placeholder ?? 'Add a task'}
        aria-label="Add a task"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        // Blur KEEPS the text: a half-typed task is worth more than a tidy field, and creating on
        // blur would make clicking away a destructive-feeling surprise.
      />
    </div>
  );
}
