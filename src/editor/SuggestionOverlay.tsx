// One inline-suggestion engine for the editors. Modes:
//   - 'mention' : `@query` in any taskItem → board-member (assignee) picker
//   - 'command' : `/cmd arg` in any taskItem → set a property (due / status / priority)
// One overlay component + one keydown handler, so the modes never fight over keys.
// `resolveHomeTab` is supplied per editor (the @ picker is scoped to a task's home board).

import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { nanoid } from 'nanoid';
import { useStore } from '../store';
import { extractTokens } from '../util/parse';
import { resolveDateKeyword, formatDateChip, toISO, todayISO } from '../util/dates';
import { taskItemInnerRange } from './taskItemDoc';
import type { ID, Member, TaskStatus } from '../types';

interface CommandItem { key: string; label: string; run: () => void }

export type ResolveHomeTab = (taskItemPos: number, existingId: string | null) => ID | undefined;

type Mode =
  | { kind: 'mention'; query: string; matches: Member[]; x: number; y: number; onPick: (m: Member) => void }
  | { kind: 'command'; query: string; matches: CommandItem[]; x: number; y: number; onPick: (m: CommandItem) => void };

const MAX = 8;

function rankMembers(members: Member[], query: string): Member[] {
  const q = query.toLowerCase();
  if (!q) return members.slice(0, MAX);
  const scored: { m: Member; score: number }[] = [];
  for (const m of members) {
    const n = m.name.toLowerCase();
    const e = m.email.toLowerCase();
    let score = -1;
    if (n === q) score = 200;
    else if (n.startsWith(q)) score = 100;
    else if (n.includes(q)) score = 50;
    else if (e.includes(q)) score = 30;
    if (score >= 0) scored.push({ m, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX).map((s) => s.m);
}

const STATUS_DEFS: { s: TaskStatus; label: string; aliases: string[] }[] = [
  { s: 'todo', label: 'Todo', aliases: ['status', 'todo'] },
  { s: 'in_progress', label: 'In progress', aliases: ['status', 'doing', 'wip', 'inprogress'] },
  { s: 'in_review', label: 'In review', aliases: ['status', 'review', 'inreview'] },
  { s: 'done', label: 'Done', aliases: ['status', 'done'] },
  { s: 'cancelled', label: 'Cancelled', aliases: ['status', 'cancel', 'cancelled'] },
];

/** Build the `/` command list for `cmd`/`arg`; each item applies a property via `apply`. */
function buildCommands(cmd: string, arg: string, apply: (mutate: (id: ID) => void) => void): CommandItem[] {
  const items: CommandItem[] = [];
  const matches = (kw: string) => cmd === '' || kw.startsWith(cmd) || cmd.startsWith(kw);
  const setMeta = (patch: Parameters<ReturnType<typeof useStore.getState>['setTaskMeta']>[1]) =>
    apply((id) => useStore.getState().setTaskMeta(id, patch));

  // Due date
  if (matches('due') || matches('date') || matches('today') || matches('tomorrow')) {
    if (arg) {
      const r = resolveDateKeyword(arg);
      if (r) items.push({ key: 'due-arg', label: `Due · ${formatDateChip(r)}`, run: () => setMeta({ date: r }) });
    }
    const tm = new Date();
    tm.setDate(tm.getDate() + 1);
    items.push({ key: 'due-today', label: 'Due · today', run: () => setMeta({ date: todayISO() }) });
    items.push({ key: 'due-tomorrow', label: 'Due · tomorrow', run: () => setMeta({ date: toISO(tm) }) });
  }
  // Status
  for (const st of STATUS_DEFS) {
    if (st.aliases.some(matches))
      items.push({ key: `st-${st.s}`, label: `Status · ${st.label}`, run: () => apply((id) => useStore.getState().setTaskStatus(id, st.s)) });
  }
  // Priority
  if (matches('priority') || cmd === 'p' || ['p1', 'p2', 'p3'].some(matches)) {
    for (const p of [1, 2, 3] as const)
      items.push({ key: `p${p}`, label: `Priority · ${'!'.repeat(p)}`, run: () => setMeta({ priority: p }) });
  }
  return items.slice(0, MAX);
}

/** Strip the `@query`, ensure the taskItem has an id, then set the assignee on the entity. */
function assignMention(
  editor: Editor,
  taskItemPos: number,
  atPos: number,
  cursor: number,
  existingId: string | null,
  homeTabId: ID | undefined,
  member: Member,
): void {
  const store = useStore.getState();
  let id = existingId;
  let tr = editor.state.tr;
  if (!id) {
    id = `t_${nanoid(8)}`;
    const node = editor.state.doc.nodeAt(taskItemPos);
    if (node) tr = tr.setNodeMarkup(taskItemPos, undefined, { ...node.attrs, id });
  }
  tr = tr.delete(atPos, cursor);
  editor.view.dispatch(tr);
  editor.view.focus();

  if (!homeTabId) return;
  // Ensure the entity exists, then set the assignee. The sync-plugin merge spreads the
  // existing task, so this assignee survives the subsequent text mirror (SPEC §8).
  const text = extractTokens(editor.state.doc.nodeAt(taskItemPos)?.firstChild?.textContent ?? '').text;
  if (!store.tasks[id]) store.upsertTask({ id, homeTabId, text });
  store.setTaskAssignee(id, member.id);
}

function computeMode(editor: Editor, resolveHomeTab: ResolveHomeTab): Mode | null {
  const state = editor.state;
  const $from = state.selection.$from;
  if ($from.depth < 1) return null;
  const coords = editor.view.coordsAtPos(state.selection.from);

  // Locate the taskItem containing the cursor (used by 'mention' and 'task').
  let taskItemPos = -1;
  let taskItemNode: ReturnType<typeof state.doc.nodeAt> = null;
  for (let d = $from.depth; d >= 0; d--) {
    if ($from.node(d).type.name === 'taskItem') {
      taskItemPos = $from.before(d);
      taskItemNode = $from.node(d);
      break;
    }
  }

  // --- MENTION / COMMAND: `@query` or `/cmd arg` before the cursor inside a taskItem ---
  if (taskItemPos >= 0 && taskItemNode && taskItemNode.firstChild) {
    const { from: innerFrom } = taskItemInnerRange(taskItemPos, taskItemNode.firstChild);
    const cursor = state.selection.from;
    if (cursor >= innerFrom) {
      const before = state.doc.textBetween(innerFrom, cursor, '\n', '\n');
      const existingId = (taskItemNode.attrs.id as string | null) ?? null;

      const m = before.match(/(?:^|\s)@(\w*)$/);
      if (m) {
        const query = m[1];
        const atPos = cursor - query.length - 1;
        const homeTabId = resolveHomeTab(taskItemPos, existingId);
        const members = homeTabId ? useStore.getState().membersByBoard[homeTabId] ?? [] : [];
        const matches = rankMembers(members, query);
        if (matches.length) {
          return {
            kind: 'mention',
            query,
            matches,
            x: coords.left,
            y: coords.bottom + 4,
            onPick: (mem) => assignMention(editor, taskItemPos, atPos, cursor, existingId, homeTabId, mem),
          };
        }
        return null; // an @ is being typed but nothing matches — don't show other modes
      }

      // `/` slash command sets a PROPERTY on this task (due / status / priority).
      const cm = before.match(/(?:^|\s)\/(\w*)(?:\s+(\S+))?$/);
      if (cm) {
        const cmd = (cm[1] ?? '').toLowerCase();
        const arg = (cm[2] ?? '').trim();
        const slashPos = cursor - cm[0].length + (cm[0][0] === '/' ? 0 : 1);
        const homeTabId = resolveHomeTab(taskItemPos, existingId);
        // Apply a property mutation: strip the slash text, ensure an id, write the entity.
        const apply = (mutate: (id: ID) => void) => {
          const store = useStore.getState();
          let id = existingId;
          let tr = editor.state.tr;
          if (!id) {
            id = `t_${nanoid(8)}`;
            const n = editor.state.doc.nodeAt(taskItemPos);
            if (n) tr = tr.setNodeMarkup(taskItemPos, undefined, { ...n.attrs, id });
          }
          tr = tr.delete(slashPos, cursor);
          editor.view.dispatch(tr);
          editor.view.focus();
          const text = extractTokens(editor.state.doc.nodeAt(taskItemPos)?.firstChild?.textContent ?? '').text;
          if (!store.tasks[id]) {
            if (!homeTabId) return;
            store.upsertTask({ id, homeTabId, text });
          }
          mutate(id);
        };
        const matches = buildCommands(cmd, arg, apply);
        if (matches.length) {
          return { kind: 'command', query: cmd, matches, x: coords.left, y: coords.bottom + 4, onPick: (it) => it.run() };
        }
        return null;
      }
    }
  }

  // No `@`/`/` trigger under the cursor → nothing to suggest.
  return null;
}

function pickItem(mode: Mode, item: Member | CommandItem): void {
  if (mode.kind === 'mention') mode.onPick(item as Member);
  else mode.onPick(item as CommandItem);
}

export function SuggestionOverlay({ editor, resolveHomeTab }: { editor: Editor; resolveHomeTab: ResolveHomeTab }) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [highlight, setHighlight] = useState(0);

  useEffect(() => {
    if (!editor) return;
    const update = () => {
      const next = computeMode(editor, resolveHomeTab);
      setMode(next);
      setHighlight(0);
    };
    editor.on('update', update);
    editor.on('selectionUpdate', update);
    editor.on('focus', update);
    editor.on('blur', () => setTimeout(() => setMode(null), 120));
    update();
    return () => {
      editor.off('update', update);
      editor.off('selectionUpdate', update);
      editor.off('focus', update);
    };
  }, [editor, resolveHomeTab]);

  useEffect(() => {
    if (!editor || !mode) return;
    const dom = editor.view.dom;
    const onKey = (e: KeyboardEvent) => {
      const items = mode.matches;
      if (e.key === 'ArrowDown') {
        e.preventDefault(); e.stopPropagation();
        setHighlight((h) => Math.min(items.length - 1, h + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        setHighlight((h) => Math.max(0, h - 1));
      } else if (e.key === 'Tab' || (e.key === 'Enter' && (mode.kind === 'mention' || mode.kind === 'command'))) {
        e.preventDefault(); e.stopPropagation();
        const sel = items[highlight];
        if (sel) pickItem(mode, sel);
        setMode(null);
      } else if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        setMode(null);
      }
    };
    dom.addEventListener('keydown', onKey, true);
    return () => dom.removeEventListener('keydown', onKey, true);
  }, [editor, mode, highlight]);

  if (!mode) return null;

  return (
    <ul
      className={`today-suggest ${mode.kind}`}
      style={{ position: 'fixed', top: mode.y, left: mode.x, zIndex: 50 }}
    >
      {mode.matches.map((m, i) => {
        const key = mode.kind === 'mention' ? (m as Member).id : (m as CommandItem).key;
        const active = i === highlight;
        return (
          <li
            key={key}
            className={`today-suggest-item ${active ? 'active' : ''}`}
            onMouseEnter={() => setHighlight(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              pickItem(mode, m);
              setMode(null);
            }}
          >
            {mode.kind === 'mention' ? (
              <>
                <span className="today-suggest-avatar">{(m as Member).name.charAt(0).toUpperCase()}</span>
                <span className="today-suggest-name">{(m as Member).name}</span>
                <span className="today-suggest-sub">{(m as Member).email}</span>
              </>
            ) : (
              <span className="today-suggest-name">{(m as CommandItem).label}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
