// Inline suggestion engine for a task-title WIDGET (TASKS_AS_ENTITIES.md P2.5). Replaces the
// ProseMirror-coupled SuggestionOverlay for tasks: the title is now a contentEditable div bound to
// the entity, so we detect `@query` / `/cmd arg` in the div's text at the caret, show one popup,
// and on pick strip the token from the title + write the entity field (assignee / status / due /
// priority) directly. Rendered inside TaskItemView; only the focused task shows a popup.
//
// Key-capture: while the popup is open, a capture-phase keydown on the widget swallows
// Up/Down/Enter/Tab/Escape so the widget's own handlers (create task / nest / move focus) don't
// fire. stopImmediatePropagation prevents the event from reaching React's root listener.

import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { useSession } from '../session/useSession';
import { matchCommands, rankMembers, categoryOf, type CommandPatch } from './suggestEngine';
import type { ID, Member } from '../types';

interface CommandItem { key: string; label: string; category: string; run: () => void }
type Mode =
  | { kind: 'mention'; matches: Member[]; x: number; y: number; strip: () => void; onPick: (m: Member) => void }
  | { kind: 'command'; matches: CommandItem[]; x: number; y: number; strip: () => void; onPick: (m: CommandItem) => void };

function applyCommandPatch(id: ID, patch: CommandPatch): void {
  const s = useStore.getState();
  if (patch.kind === 'status') s.setTaskStatus(id, patch.status);
  else if (patch.kind === 'date') s.setTaskMeta(id, { date: patch.date ?? undefined });
  else if (patch.kind === 'priority') s.setTaskMeta(id, { priority: patch.priority ?? undefined });
  else s.setTaskAssignee(id, patch.assigneeId ?? undefined);
}

function buildCommands(cmd: string, arg: string, id: ID): CommandItem[] {
  const meId = useSession.getState().user?.id;
  return matchCommands(cmd, arg, meId).map((d) => ({
    key: d.key, label: d.label, category: categoryOf(d.patch), run: () => applyCommandPatch(id, d.patch),
  }));
}

/** Text of the widget from its start up to the caret (null if the caret isn't inside `el`). */
function caretText(el: HTMLElement): { before: string; caret: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return null;
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  const before = pre.toString();
  return { before, caret: before.length };
}

/** Caret screen position (for the popup), from the current collapsed selection. */
function caretRect(): { x: number; y: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (rect.left === 0 && rect.bottom === 0) return null;
  return { x: rect.left, y: rect.bottom + 4 };
}

/** Replace the widget's text and drop the caret at `caretPos`. */
function setWidgetText(el: HTMLElement, id: ID, text: string, caretPos: number): void {
  el.textContent = text;
  useStore.getState().setTaskText(id, text);
  el.focus();
  const node = el.firstChild;
  const range = document.createRange();
  if (node) range.setStart(node, Math.min(caretPos, node.textContent?.length ?? 0));
  else range.setStart(el, 0);
  range.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

export function TaskTitleSuggest({ inputRef, taskId, tabId }: { inputRef: React.RefObject<HTMLDivElement | null>; taskId: ID; tabId: ID }) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [highlight, setHighlight] = useState(0);
  const modeRef = useRef<Mode | null>(null);
  const hlRef = useRef(0);
  modeRef.current = mode;
  hlRef.current = highlight;

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;

    const compute = (): void => {
      const ct = caretText(el);
      if (!ct) return setMode(null);
      const { before, caret } = ct;
      const full = el.textContent ?? '';

      const at = before.match(/(?:^|\s)@(\w*)$/);
      if (at) {
        const query = at[1];
        const tokenLen = query.length + 1; // "@" + query
        const start = caret - tokenLen;
        const members = useStore.getState().membersByBoard[tabId] ?? [];
        const matches = rankMembers(members, query);
        const pos = caretRect();
        if (matches.length && pos) {
          setHighlight(0);
          setMode({
            kind: 'mention', matches, x: pos.x, y: pos.y,
            strip: () => setWidgetText(el, taskId, full.slice(0, start) + full.slice(caret), start),
            onPick: (m) => useStore.getState().setTaskAssignee(taskId, m.id),
          });
          return;
        }
        return setMode(null);
      }

      // The trailing arg slot must not itself look like the start of a new token — otherwise an
      // earlier, still-unconfirmed "/cmd" absorbs a second "/cmd"/"@mention" typed right after it
      // as if it were plain argument text, and the popup gets stuck on the stale first match.
      const cm = before.match(/(?:^|\s)\/(\w*)(?:\s+(?![/@])(\S+))?$/);
      if (cm) {
        const cmd = (cm[1] ?? '').toLowerCase();
        const arg = (cm[2] ?? '').trim();
        const tokenLen = cm[0].length - (cm[0][0] === '/' ? 0 : 1);
        const start = caret - tokenLen;
        const matches = buildCommands(cmd, arg, taskId);
        const pos = caretRect();
        if (matches.length && pos) {
          setHighlight(0);
          setMode({
            kind: 'command', matches, x: pos.x, y: pos.y,
            strip: () => setWidgetText(el, taskId, full.slice(0, start) + full.slice(caret), start),
            onPick: (it) => it.run(),
          });
          return;
        }
        return setMode(null);
      }

      // `!` / `!!` / `!!!` priority sigil — only a STANDALONE run (preceded by space/start), so a
      // trailing "Fix this!" is left alone. Highlights the level you typed; Enter/Tab applies + strips.
      const bang = before.match(/(?:^|\s)(!{1,3})$/);
      if (bang) {
        const start = caret - bang[1].length;
        const items: CommandItem[] = [1, 2, 3].map((pp) => ({
          key: `pri-${pp}`,
          label: `Priority · ${'!'.repeat(pp)}`,
          category: 'Priority',
          run: () => useStore.getState().setTaskMeta(taskId, { priority: pp as 1 | 2 | 3 }),
        }));
        const pos = caretRect();
        if (pos) {
          setHighlight(Math.min(bang[1].length - 1, 2));
          setMode({
            kind: 'command', matches: items, x: pos.x, y: pos.y,
            strip: () => setWidgetText(el, taskId, full.slice(0, start) + full.slice(caret), start),
            onPick: (it) => it.run(),
          });
          return;
        }
      }
      setMode(null);
    };

    const onBlur = () => setTimeout(() => setMode(null), 120);
    el.addEventListener('input', compute);
    el.addEventListener('mouseup', compute);
    el.addEventListener('blur', onBlur);

    // Capture-phase: while the popup is open, own the nav keys before the widget's handlers.
    const onKeyCapture = (e: KeyboardEvent) => {
      const m = modeRef.current;
      if (!m) return;
      const items = m.matches;
      if (e.key === 'ArrowDown') {
        e.preventDefault(); e.stopImmediatePropagation();
        setHighlight((h) => Math.min(items.length - 1, h + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); e.stopImmediatePropagation();
        setHighlight((h) => Math.max(0, h - 1));
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault(); e.stopImmediatePropagation();
        const sel = items[hlRef.current];
        if (sel) { m.strip(); if (m.kind === 'mention') m.onPick(sel as Member); else m.onPick(sel as CommandItem); }
        setMode(null);
      } else if (e.key === 'Escape') {
        e.preventDefault(); e.stopImmediatePropagation();
        setMode(null);
      }
    };
    el.addEventListener('keydown', onKeyCapture, true);

    return () => {
      el.removeEventListener('input', compute);
      el.removeEventListener('mouseup', compute);
      el.removeEventListener('blur', onBlur);
      el.removeEventListener('keydown', onKeyCapture, true);
    };
  }, [inputRef, taskId, tabId]);

  if (!mode) return null;

  return (
    <ul className={`today-suggest ${mode.kind}`} style={{ position: 'fixed', top: mode.y, left: mode.x, zIndex: 50 }} contentEditable={false}>
      {(() => {
        const isMention = mode.kind === 'mention';
        const nodes: React.ReactNode[] = [];
        let prevCategory: string | null = null;
        mode.matches.forEach((m, i) => {
          // A header whenever the (already relevance-sorted) list crosses into a new category —
          // never reorders anything, just annotates transitions as they occur.
          if (!isMention) {
            const category = (m as CommandItem).category;
            if (category !== prevCategory) {
              nodes.push(<li key={`cat-${category}`} className="today-suggest-cat" aria-hidden>{category}</li>);
              prevCategory = category;
            }
          }
          const key = isMention ? (m as Member).id : (m as CommandItem).key;
          nodes.push(
            <li
              key={key}
              className={`today-suggest-item ${i === highlight ? 'active' : ''}`}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                mode.strip();
                if (mode.kind === 'mention') mode.onPick(m as Member);
                else mode.onPick(m as CommandItem);
                setMode(null);
              }}
            >
              {isMention ? (
                <>
                  <span className="today-suggest-avatar">{(m as Member).name.charAt(0).toUpperCase()}</span>
                  <span className="today-suggest-name">{(m as Member).name}</span>
                  <span className="today-suggest-sub">{(m as Member).email}</span>
                </>
              ) : (
                <span className="today-suggest-name">{(m as CommandItem).label}</span>
              )}
            </li>,
          );
        });
        return nodes;
      })()}
    </ul>
  );
}
