import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { TextSelection, type EditorState } from '@tiptap/pm/state';
import { useStore } from '../store';
import { parseHeader, type TabMatch } from '../util/header';
import { blockHeaderKey } from './extensions/BlockHeader';
import type { ID } from '../types';

interface TaskMatch { id: ID; text: string; done: boolean }

type Mode =
  | {
      kind: 'tab';
      query: string;
      matches: TabMatch[];
      x: number;
      y: number;
      onPick: (m: TabMatch) => void;
    }
  | {
      kind: 'task';
      query: string;
      matches: TaskMatch[];
      x: number;
      y: number;
      onPick: (m: TaskMatch) => void;
    };

const MAX = 8;

function computeMode(editor: Editor): Mode | null {
  const state = editor.state;
  const $from = state.selection.$from;
  if ($from.depth < 1) return null;
  const topPos = $from.before(1);
  const topNode = state.doc.nodeAt(topPos);
  if (!topNode) return null;
  const { tabs, projects, tabOrder, tasks } = useStore.getState();

  // Coords for positioning. Use the selection's screen coords.
  const coords = editor.view.coordsAtPos(state.selection.from);

  // --- HEADER paragraph: tab autocomplete ---
  if (topNode.type.name === 'paragraph') {
    const text = topNode.textContent;
    const parsed = parseHeader(text, tabs, projects, tabOrder);
    if (!parsed.isHeader) return null;
    // Only show when cursor has moved past the time token.
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
        // Replace everything after the time token with " <tab name>", preserving cursor at end.
        const paraStart = topPos + 1;
        const afterTokenPos = paraStart + parsed.tokenLen;
        const paraEnd = topPos + topNode.nodeSize - 1;
        const insert = ' ' + m.name;
        const tr = editor.state.tr.replaceWith(
          afterTokenPos,
          paraEnd,
          editor.state.schema.text(insert),
        );
        const newPos = afterTokenPos + insert.length;
        tr.setSelection(TextSelection.near(tr.doc.resolve(newPos)));
        editor.view.dispatch(tr);
        editor.view.focus();
      },
    };
  }

  // --- TASK in a bound block: task autocomplete ---
  let taskItemPos = -1;
  let taskItemNode: typeof topNode | null = null;
  for (let d = $from.depth; d >= 0; d--) {
    if ($from.node(d).type.name === 'taskItem') {
      taskItemPos = $from.before(d);
      taskItemNode = $from.node(d);
      break;
    }
  }
  if (taskItemPos < 0 || !taskItemNode) return null;
  const taskText = (taskItemNode.firstChild?.textContent ?? '').trim();

  // Look up region containing this taskItem.
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
    .sort((a, b) => (a.done === b.done ? 0 : a.done ? 1 : -1))
    .slice(0, MAX);
  if (taskList.length === 0) return null;

  return {
    kind: 'task',
    query: taskText,
    matches: taskList.map((t) => ({ id: t.id, text: t.text, done: !!t.done })),
    x: coords.left,
    y: coords.bottom + 4,
    onPick: (m) => {
      // Replace text of the taskItem and set its id to m.id (turns it into a reference).
      const para = taskItemNode!.firstChild;
      if (!para) return;
      const innerFrom = taskItemPos + 2;
      const innerTo = taskItemPos + 1 + para.nodeSize - 1;
      const tr = editor.state.tr.replaceWith(innerFrom, innerTo, editor.state.schema.text(m.text));
      tr.setNodeMarkup(taskItemPos, undefined, { ...taskItemNode!.attrs, id: m.id });
      tr.setMeta('externalEdit', true);
      tr.setSelection(TextSelection.near(tr.doc.resolve(innerFrom + m.text.length)));
      editor.view.dispatch(tr);
      editor.view.focus();
    },
  };
}

export function TodaySuggestionOverlay({ editor }: { editor: Editor }) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [highlight, setHighlight] = useState(0);

  useEffect(() => {
    if (!editor) return;
    const update = () => {
      const next = computeMode(editor);
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
  }, [editor]);

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
      } else if (e.key === 'Tab') {
        e.preventDefault(); e.stopPropagation();
        const sel = items[highlight];
        if (sel) {
          if (mode.kind === 'tab') mode.onPick(sel as TabMatch);
          else mode.onPick(sel as TaskMatch);
        }
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
        const key = mode.kind === 'tab' ? (m as TabMatch).tabId : (m as TaskMatch).id;
        const active = i === highlight;
        return (
          <li
            key={key}
            className={`today-suggest-item ${active ? 'active' : ''}`}
            onMouseEnter={() => setHighlight(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              if (mode.kind === 'tab') mode.onPick(m as TabMatch);
              else mode.onPick(m as TaskMatch);
            }}
          >
            {mode.kind === 'tab' ? (
              <>
                <span className="today-suggest-dot" style={{ background: (m as TabMatch).projectColor }} />
                <span className="today-suggest-name">{(m as TabMatch).name}</span>
                <span className="today-suggest-sub">{(m as TabMatch).projectName}</span>
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
