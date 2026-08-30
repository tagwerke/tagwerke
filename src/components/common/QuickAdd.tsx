// The quick-add line: a task is typed here, not in a document (NOTES_SPLIT_PLAN §N1, §I.1).
//
// It is a plain <input>, deliberately — the doc's title is a contentEditable because it is bound to
// a row that already exists, and none of that applies to a line that is still a draft. What the two
// DO share is the grammar: `detectToken` (suggestEngine) decides what is being typed and
// `SuggestPopup` draws the list, so `/due fri` means the same thing in both places. Only the caret
// plumbing differs, and that is the part that genuinely differs between an input and a widget.
//
// Tokens picked from the popup are stripped from the text and accumulated into a draft field bag;
// tokens typed without picking are caught by `parseEmbeddedCommands` on submit, the same fallback
// the doc runs on blur. Nothing is created until Enter.

import { useEffect, useRef, useState } from 'react';
import { ancestorsOf, useStore } from '../../store';
import { useSession } from '../../session/useSession';
import { detectToken, matchCommands, rankMembers, categoryOf, type CommandPatch } from '../../editor/suggestEngine';
import { parseEmbeddedCommands } from '../../editor/embeddedCommands';
import { createTaskInBoard, type DraftFields } from '../../tasks/createTask';
import { SuggestPopup, type SuggestItem } from './SuggestPopup';
import { registerQuickAdd } from '../../tasks/quickAddFocus';
import { MAX_TASK_DEPTH } from '../../../shared/tree';
import type { ID, Member } from '../../types';

interface CommandChoice extends SuggestItem {
  patch: CommandPatch;
}

type Mode =
  | { kind: 'mention'; items: Member[]; start: number; x: number; y: number }
  | { kind: 'command'; items: CommandChoice[]; start: number; x: number; y: number };

function applyToDraft(draft: DraftFields, patch: CommandPatch): DraftFields {
  switch (patch.kind) {
    case 'status': return { ...draft, status: patch.status };
    case 'date': return { ...draft, date: patch.date };
    case 'priority': return { ...draft, priority: patch.priority };
    case 'assignee': return { ...draft, assigneeId: patch.assigneeId };
  }
}

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
  const [mode, setMode] = useState<Mode | null>(null);
  const [highlight, setHighlight] = useState(0);
  // Not state: a pick must not re-render the field mid-keystroke, and nothing renders from it.
  const draft = useRef<DraftFields>({});
  /**
   * Nesting, restored as a gesture rather than a menu item (§N2.5). In the document you pressed
   * Enter then Tab and kept typing; the same two keys do the same thing here. Tab nests the NEXT
   * task under the one just added, Shift+Tab steps back out, and the line says which parent it is
   * about to write under so the state is never invisible.
   */
  const [nestUnder, setNestUnder] = useState<ID | null>(null);
  const lastCreated = useRef<ID | null>(null);
  const role = useStore((s) => s.tabs[tabId]?.role);
  const canEdit = role !== 'viewer';

  useEffect(() => {
    if (!shortcut) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'n' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement;
      // Never steal the key from something already taking text.
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return;
      if (el instanceof HTMLElement && el.isContentEditable) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    const unregister = registerQuickAdd(tabId, () => inputRef.current?.focus());
    return () => {
      window.removeEventListener('keydown', onKey);
      unregister();
    };
  }, [shortcut, tabId]);

  const parentTitle = useStore((s) => (nestUnder ? s.tasks[nestUnder]?.text : undefined));

  if (!canEdit) return null;

  /** Where the popup hangs: under the field. An <input> has no per-character caret rect. */
  const anchor = (): { x: number; y: number } => {
    const r = inputRef.current?.getBoundingClientRect();
    return { x: r?.left ?? 0, y: (r?.bottom ?? 0) + 4 };
  };

  const recompute = (text: string, caret: number): void => {
    const token = detectToken(text.slice(0, caret), caret);
    if (!token) return setMode(null);
    const { x, y } = anchor();

    if (token.kind === 'mention') {
      const members = useStore.getState().membersByBoard[tabId] ?? [];
      const items = rankMembers(members, token.query);
      // A `@` match wins outright — never fall through to the command grammar (suggestEngine).
      setHighlight(0);
      return setMode(items.length ? { kind: 'mention', items, start: token.start, x, y } : null);
    }

    if (token.kind === 'priority') {
      const items: CommandChoice[] = [1, 2, 3].map((p) => ({
        key: `pri-${p}`,
        label: `Priority · ${'!'.repeat(p)}`,
        category: 'Priority',
        patch: { kind: 'priority', priority: p as 1 | 2 | 3 },
      }));
      setHighlight(Math.min(token.level - 1, 2));
      return setMode({ kind: 'command', items, start: token.start, x, y });
    }

    const meId = useSession.getState().user?.id;
    const items: CommandChoice[] = matchCommands(token.cmd, token.arg, meId).map((d) => ({
      key: d.key, label: d.label, category: categoryOf(d.patch), patch: d.patch,
    }));
    setHighlight(0);
    setMode(items.length ? { kind: 'command', items, start: token.start, x, y } : null);
  };

  /** Cut the token being suggested out of the field and put the caret where it was. */
  const strip = (start: number): string => {
    const el = inputRef.current;
    const caret = el?.selectionStart ?? value.length;
    const next = value.slice(0, start) + value.slice(caret);
    setValue(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start, start);
    });
    return next;
  };

  const pick = (i: number): void => {
    if (!mode) return;
    strip(mode.start);
    if (mode.kind === 'mention') {
      const m = mode.items[i];
      if (m) draft.current = { ...draft.current, assigneeId: m.id };
    } else {
      const c = mode.items[i];
      if (c) draft.current = applyToDraft(draft.current, c.patch);
    }
    setMode(null);
  };

  /** Tab: one level deeper, under whatever was added last. Refused at the depth limit. */
  const nestDeeper = (): void => {
    const anchor = nestUnder ? lastCreated.current ?? nestUnder : lastCreated.current;
    if (!anchor) return;
    const tasks = useStore.getState().tasks;
    if (ancestorsOf(tasks, anchor).length + 1 >= MAX_TASK_DEPTH) return;
    setNestUnder(anchor);
  };

  /** Shift+Tab: back out one level, to the current parent's own parent. */
  const nestShallower = (): void => {
    if (!nestUnder) return;
    setNestUnder(useStore.getState().tasks[nestUnder]?.parentTaskId ?? null);
  };

  const submit = (openAfter: boolean): void => {
    const raw = value.trim();
    if (!raw) return;
    // Tokens typed but never picked from the popup — the same sweep the doc runs on blur.
    const members = useStore.getState().membersByBoard[tabId] ?? [];
    const meId = useSession.getState().user?.id;
    const { cleanText, fields } = parseEmbeddedCommands(raw, members, meId);
    const text = cleanText.trim();
    if (!text) return; // a line of nothing but commands is not a task

    const id = createTaskInBoard(tabId, {
      text,
      // An explicit prop wins — a Kanban column's line is never nesting anything.
      parentTaskId: parentTaskId ?? nestUnder ?? undefined,
      // Picked tokens first, then typed ones, then what the surface itself implies: a Kanban
      // column's status must not be overridable by a stray `/todo` left in the line.
      fields: { ...draft.current, ...fields, ...presetFields },
    });

    draft.current = {};
    lastCreated.current = id;
    setValue('');
    setMode(null);
    if (openAfter) useStore.getState().setOpenTask(id);
    else inputRef.current?.focus(); // stay put for the next one
    onCreated?.(id);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (mode) {
      const n = mode.items.length;
      if (e.key === 'ArrowDown') { e.preventDefault(); return setHighlight((h) => Math.min(n - 1, h + 1)); }
      if (e.key === 'ArrowUp') { e.preventDefault(); return setHighlight((h) => Math.max(0, h - 1)); }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return pick(highlight); }
      if (e.key === 'Escape') { e.preventDefault(); return setMode(null); } // closes the popup only
    }
    // Tab only reaches here with no popup open, where it means nesting rather than picking.
    if (e.key === 'Tab' && !parentTaskId) {
      e.preventDefault();
      return e.shiftKey ? nestShallower() : nestDeeper();
    }
    if (e.key === 'Enter') { e.preventDefault(); return submit(e.shiftKey); }
    if (e.key === 'Escape') {
      e.preventDefault();
      draft.current = {};
      setValue('');
      setNestUnder(null);
      inputRef.current?.blur();
    }
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
        placeholder={nestUnder ? 'Sub-task' : placeholder ?? 'Add a task — try / or @'}
        aria-label="Add a task"
        onChange={(e) => {
          setValue(e.target.value);
          recompute(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onKeyUp={(e) => {
          // Arrow keys and clicks move the caret without changing the text.
          if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') {
            recompute(e.currentTarget.value, e.currentTarget.selectionStart ?? 0);
          }
        }}
        onKeyDown={onKeyDown}
        // Blur KEEPS the text: a half-typed task is worth more than a tidy field, and creating on
        // blur would make clicking away a destructive-feeling surprise.
        onBlur={() => setTimeout(() => setMode(null), 120)}
      />
      {value.trim() && <span className="quick-add-hint">Enter to add</span>}
      {mode && (
        <SuggestPopup
          kind={mode.kind}
          items={mode.items}
          highlight={highlight}
          x={mode.x}
          y={mode.y}
          onHighlight={setHighlight}
          onPick={pick}
        />
      )}
    </div>
  );
}
