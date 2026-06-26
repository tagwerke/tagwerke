// One inline-suggestion engine for the editors. Modes:
//   - 'tab'     : Today block-header → tab autocomplete (structural)
//   - 'task'    : Today bound-block → task reference autocomplete (structural)
//   - 'mention' : `@query` in any taskItem → board-member (assignee) picker
// One overlay component + one keydown handler, so the modes never fight over keys.
// `resolveHomeTab` is supplied per editor (the @ picker is scoped to a task's home board).

import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { TextSelection, type EditorState } from '@tiptap/pm/state';
import { nanoid } from 'nanoid';
import { useStore } from '../store';
import { parseHeader, type TabMatch } from '../util/header';
import { extractTokens } from '../util/parse';
import { blockHeaderKey } from './extensions/BlockHeader';
import { taskItemInnerRange } from './taskItemDoc';
import type { ID, Member } from '../types';

interface TaskMatch { id: ID; text: string; done: boolean }

export type ResolveHomeTab = (taskItemPos: number, existingId: string | null) => ID | undefined;

type Mode =
  | { kind: 'tab'; query: string; matches: TabMatch[]; x: number; y: number; onPick: (m: TabMatch) => void }
  | { kind: 'task'; query: string; matches: TaskMatch[]; x: number; y: number; onPick: (m: TaskMatch) => void }
  | { kind: 'mention'; query: string; matches: Member[]; x: number; y: number; onPick: (m: Member) => void };

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
  const { tabs, projects, tabOrder, tasks } = useStore.getState();
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

  // --- MENTION: `@query` immediately before the cursor inside a taskItem ---
  if (taskItemPos >= 0 && taskItemNode && taskItemNode.firstChild) {
    const { from: innerFrom } = taskItemInnerRange(taskItemPos, taskItemNode.firstChild);
    const cursor = state.selection.from;
    if (cursor >= innerFrom) {
      const before = state.doc.textBetween(innerFrom, cursor, '\n', '\n');
      const m = before.match(/(?:^|\s)@(\w*)$/);
      if (m) {
        const query = m[1];
        const atPos = cursor - query.length - 1;
        const existingId = (taskItemNode.attrs.id as string | null) ?? null;
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
    }
  }

  const topPos = $from.before(1);
  const topNode = state.doc.nodeAt(topPos);
  if (!topNode) return null;

  // --- HEADER paragraph: tab autocomplete (Today only; no-op elsewhere) ---
  if (topNode.type.name === 'paragraph') {
    const text = topNode.textContent;
    const parsed = parseHeader(text, tabs, projects, tabOrder);
    if (!parsed.isHeader) return null;
    const cursorOffsetInPara = state.selection.from - (topPos + 1);
    if (cursorOffsetInPara < parsed.tokenLen) return null;
    if (parsed.matches.length === 0) return null;
    return {
      kind: 'tab',
      query: parsed.remainder,
      matches: parsed.matches.slice(0, MAX),
      x: coords.left,
      y: coords.bottom + 4,
      onPick: (m) => {
        const paraStart = topPos + 1;
        const afterTokenPos = paraStart + parsed.tokenLen;
        const paraEnd = topPos + topNode.nodeSize - 1;
        const insert = ' ' + m.name;
        const tr = editor.state.tr.replaceWith(afterTokenPos, paraEnd, editor.state.schema.text(insert));
        const newPos = afterTokenPos + insert.length;
        tr.setSelection(TextSelection.near(tr.doc.resolve(newPos)));
        editor.view.dispatch(tr);
        editor.view.focus();
      },
    };
  }

  // --- TASK in a bound block: task autocomplete (Today only) ---
  if (taskItemPos < 0 || !taskItemNode) return null;
  const taskText = (taskItemNode.firstChild?.textContent ?? '').trim();

  const regions = blockHeaderKey.getState(state as EditorState)?.regions ?? [];
  let boundTabId: ID | undefined;
  for (const r of regions) {
    if (taskItemPos > r.headerPos && taskItemPos > r.headerPos + r.headerSize - 1) {
      boundTabId = r.tabId;
    } else if (taskItemPos <= r.headerPos) {
      break;
    }
  }
  if (!boundTabId) return null;

  const q = taskText.toLowerCase();
  const currentId = (taskItemNode.attrs.id as string | null) ?? null;
  const taskList = Object.values(tasks)
    .filter((t) => t.homeTabId === boundTabId && t.id !== currentId)
    .filter((t) => !q || t.text.toLowerCase().includes(q))
    .sort((a, b) => (!!a.done === !!b.done ? 0 : a.done ? 1 : -1))
    .slice(0, MAX);
  if (taskList.length === 0) return null;

  return {
    kind: 'task',
    query: taskText,
    matches: taskList.map((t) => ({ id: t.id, text: t.text, done: t.status === 'done' })),
    x: coords.left,
    y: coords.bottom + 4,
    onPick: (m) => {
      const para = taskItemNode!.firstChild;
      if (!para) return;
      const { from: innerFrom, to: innerTo } = taskItemInnerRange(taskItemPos, para);
      const tr = editor.state.tr.replaceWith(innerFrom, innerTo, editor.state.schema.text(m.text));
      tr.setNodeMarkup(taskItemPos, undefined, { ...taskItemNode!.attrs, id: m.id });
      tr.setMeta('externalEdit', true);
      tr.setSelection(TextSelection.near(tr.doc.resolve(innerFrom + m.text.length)));
      editor.view.dispatch(tr);
      editor.view.focus();
    },
  };
}

function pickItem(mode: Mode, item: TabMatch | TaskMatch | Member): void {
  if (mode.kind === 'tab') mode.onPick(item as TabMatch);
  else if (mode.kind === 'task') mode.onPick(item as TaskMatch);
  else mode.onPick(item as Member);
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
      } else if (e.key === 'Tab' || (e.key === 'Enter' && mode.kind === 'mention')) {
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
        const key =
          mode.kind === 'tab' ? (m as TabMatch).tabId : mode.kind === 'mention' ? (m as Member).id : (m as TaskMatch).id;
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
            {mode.kind === 'tab' ? (
              <>
                <span className="today-suggest-dot" style={{ background: (m as TabMatch).projectColor }} />
                <span className="today-suggest-name">{(m as TabMatch).name}</span>
                <span className="today-suggest-sub">{(m as TabMatch).projectName}</span>
              </>
            ) : mode.kind === 'mention' ? (
              <>
                <span className="today-suggest-avatar">{(m as Member).name.charAt(0).toUpperCase()}</span>
                <span className="today-suggest-name">{(m as Member).name}</span>
                <span className="today-suggest-sub">{(m as Member).email}</span>
              </>
            ) : (
              <>
                <span className={`today-suggest-dot ${(m as TaskMatch).done ? 'done' : ''}`} />
                <span className="today-suggest-name">{(m as TaskMatch).text || <em>(empty)</em>}</span>
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}
