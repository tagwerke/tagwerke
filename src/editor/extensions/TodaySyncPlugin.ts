// Today-specific sync. Walks the doc, identifies block headers, assigns each
// taskItem to the home tab of the nearest preceding header, and mirrors
// committed taskItems to the tasks store. Never drops tasks — Today never
// owns any.

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Transaction, EditorState } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { nanoid } from 'nanoid';
import { useStore } from '../../store';
import { parseHeader } from '../../util/header';
import { extractTokens, hasTokens } from '../../util/parse';
import { propagateTaskText, ensureTaskInDoc } from '../registry';
import type { ID, Task } from '../../types';

const key = new PluginKey('today-sync');

interface ScannedItem {
  id: string | null;
  pos: number;
  size: number;
  text: string;
  done: boolean;
  cursorInside: boolean;
  boundTabId?: ID;
}

function scanDoc(state: EditorState): { items: ScannedItem[]; seenDuplicate: Set<ID> } {
  const { tabs, projects, tabOrder } = useStore.getState();
  const items: ScannedItem[] = [];
  const seenIds = new Set<ID>();
  const seenDuplicate = new Set<ID>();
  const sel = state.selection;
  let currentTabId: ID | undefined;

  state.doc.forEach((topNode: PMNode, topOffset: number) => {
    if (topNode.type.name === 'paragraph') {
      const parsed = parseHeader(topNode.textContent, tabs, projects, tabOrder);
      if (parsed.isHeader) {
        currentTabId = parsed.tabId;
        return;
      }
      return;
    }
    // Descend into the top-level node for taskItems.
    topNode.descendants((node, relPos) => {
      if (node.type.name !== 'taskItem') return true;
      const absPos = topOffset + 1 + relPos;
      const id = (node.attrs.id as string | null) ?? null;
      if (id) {
        if (seenIds.has(id)) seenDuplicate.add(id);
        else seenIds.add(id);
      }
      const text = node.firstChild?.textContent ?? '';
      const done = !!node.attrs.done;
      const cursorInside = sel.from > absPos && sel.from < absPos + node.nodeSize;
      items.push({
        id,
        pos: absPos,
        size: node.nodeSize,
        text,
        done,
        cursorInside,
        boundTabId: currentTabId,
      });
      return true;
    });
  });
  return { items, seenDuplicate };
}

export const TodaySyncPlugin = Extension.create({
  name: 'todaySync',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        appendTransaction: (transactions, _oldState, newState) => {
          const externalEdit = transactions.some((t) => t.getMeta('externalEdit'));
          const { items, seenDuplicate } = scanDoc(newState);

          let tr: Transaction | null = null;

          if (!externalEdit) {
            const reId = (it: ScannedItem, newId: string | null) => {
              const node = newState.doc.nodeAt(it.pos);
              if (!node) return;
              tr = tr ?? newState.tr;
              tr.setNodeMarkup(it.pos, undefined, { ...node.attrs, id: newId });
              it.id = newId;
            };
            const hasText = (it: ScannedItem) => !!extractTokens(it.text).text.trim();

            // (1) Resolve duplicate ids — e.g. pressing Enter splits a line and the new line
            // is cloned WITH the original id (splitListItem / base splitBlock both copy attrs).
            // The id must stay on the line that still holds the TEXT (the original that owns the
            // task entity), so its metadata never detaches. The empty clone loses the id (it is
            // re-created on commit); a non-empty extra (mid-line split) gets its own fresh id.
            const survivor = new Map<ID, number>(); // id -> chosen pos
            for (const it of items) {
              if (!it.id || !seenDuplicate.has(it.id)) continue;
              if (!survivor.has(it.id) && hasText(it)) survivor.set(it.id, it.pos);
            }
            for (const it of items) {
              if (!it.id || !seenDuplicate.has(it.id)) continue;
              if (!survivor.has(it.id)) survivor.set(it.id, it.pos); // fallback: first occurrence
            }
            for (const it of items) {
              if (!it.id || !seenDuplicate.has(it.id) || survivor.get(it.id) === it.pos) continue;
              reId(it, hasText(it) ? `t_${nanoid(8)}` : null);
            }

            // (2) Mint a fresh id for a committed new line: bound to a block, has text, and the
            // cursor has moved away (so the line being typed isn't turned into a task too early).
            for (const it of items) {
              if (it.id || !it.boundTabId) continue;
              if (!hasText(it) || it.cursorInside) continue;
              reId(it, `t_${nanoid(8)}`);
            }

            // Strip chip tokens (`!2`, `@2025…`, `[mike]`) on commit, like the regular SyncPlugin.
            const stripOps: { from: number; to: number; insert: string }[] = [];
            for (const it of items) {
              if (it.cursorInside) continue;
              if (!hasTokens(it.text)) continue;
              const parsed = extractTokens(it.text);
              if (parsed.text === it.text) continue;
              const node = newState.doc.nodeAt(it.pos);
              const para = node?.firstChild;
              if (!para) continue;
              const innerFrom = it.pos + 2;
              const innerTo = it.pos + 1 + para.nodeSize - 1;
              stripOps.push({ from: innerFrom, to: innerTo, insert: parsed.text });
            }
            if (stripOps.length) {
              tr = tr ?? newState.tr;
              stripOps.sort((a, b) => b.from - a.from);
              for (const op of stripOps) {
                tr.replaceWith(op.from, op.to, op.insert ? newState.schema.text(op.insert) : []);
              }
            }
          }

          // Mirror to store (deferred to avoid mutating store inside a transaction).
          const snapshot = items.map((it) => ({ ...it }));
          queueMicrotask(() => {
            const store = useStore.getState();
            const todayId = store.todayTabId;
            const updates: Record<ID, Task> = { ...store.tasks };
            let changed = false;
            // Cross-doc effects, applied AFTER the store update so the entity exists first.
            const created: { homeTabId: ID; id: ID; text: string }[] = [];
            const textPushes: { homeTabId: ID; id: ID; text: string }[] = [];
            for (const it of snapshot) {
              if (!it.id) continue;
              const parsed = extractTokens(it.text);
              const text = parsed.text;
              const existing = updates[it.id];
              // Referenced tasks (existing record) keep their original homeTabId.
              // New tasks adopt the block's bound tab.
              const homeTabId = existing?.homeTabId ?? it.boundTabId ?? '';
              if (!homeTabId) continue;
              // Status/assignee/position are entity-only — preserve via spread. A checkbox
              // token still maps to status (paste/markdown compatibility).
              const status =
                parsed.done != null ? (parsed.done ? 'done' : 'todo') : existing?.status ?? 'todo';
              const merged: Task = {
                ...existing,
                id: it.id,
                homeTabId,
                text,
                status,
                date: parsed.date ?? existing?.date,
                priority: parsed.priority ?? existing?.priority,
                owner: parsed.owner ?? existing?.owner,
                position: existing?.position ?? 0,
                done: status === 'done',
              };
              const isNew = !existing;
              const textChanged = !!existing && existing.text !== merged.text;
              const statusChanged = !!existing && (existing.status ?? 'todo') !== merged.status;
              if (
                isNew ||
                textChanged ||
                statusChanged ||
                existing.date !== merged.date ||
                existing.priority !== merged.priority ||
                existing.owner !== merged.owner
              ) {
                updates[it.id] = merged;
                changed = true;

                // A task born in Today is materialised on its home tab (2-way sync, phase 1).
                // Status is shared via the entity (no doc mirroring); only TEXT needs write-back.
                if (isNew) created.push({ homeTabId, id: it.id, text: merged.text });
                else if (textChanged) textPushes.push({ homeTabId, id: it.id, text: merged.text });
              }
            }
            if (changed) useStore.setState({ tasks: updates });
            for (const c of created) ensureTaskInDoc(c.homeTabId, c.id, c.text);
            for (const p of textPushes) propagateTaskText(p.id, p.text, todayId, [p.homeTabId]);
          });

          return tr;
        },
      }),
    ];
  },
});
