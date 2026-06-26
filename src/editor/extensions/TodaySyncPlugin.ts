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
import { applyTaskTextEditToHome } from '../registry';
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
            // Assign IDs to taskItems that are (a) under a bound block, (b) have text,
            // (c) cursor is NOT inside (commit signal — Enter has moved the cursor away, or focus blurred).
            // Also reassign duplicate IDs (e.g. from splitListItem copying attrs).
            for (const it of items) {
              const needsNew = !it.id || (it.id && seenDuplicate.has(it.id));
              if (!needsNew) continue;
              if (!it.boundTabId) continue;
              if (!extractTokens(it.text).text.trim()) continue;
              if (it.cursorInside) continue;
              const node = newState.doc.nodeAt(it.pos);
              if (!node) continue;
              tr = tr ?? newState.tr;
              const newId = `t_${nanoid(8)}`;
              tr.setNodeMarkup(it.pos, undefined, { ...node.attrs, id: newId });
              it.id = newId;
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
            const updates: Record<ID, Task> = { ...store.tasks };
            let changed = false;
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

                // Only TEXT still lives in the home doc, so only text needs write-back.
                // Status is shared via the entity — both views read it, no doc mirroring.
                if (!isNew && textChanged) {
                  const mounted = applyTaskTextEditToHome(it.id, merged.text);
                  if (!mounted) writeTextToPersistedDoc(homeTabId, it.id, merged.text);
                }
              }
            }
            if (changed) useStore.setState({ tasks: updates });
          });

          return tr;
        },
      }),
    ];
  },
});

interface DocLike { type: string; text?: string; attrs?: Record<string, unknown>; content?: DocLike[] }

// Clone the home tab's persisted docJSON, apply `mutate` to every taskItem matching
// `id`, and write it back. Used to mirror a TODAY reference edit into the home doc
// when no live editor is mounted to receive it.
function mutatePersistedTask(tabId: ID, id: ID, mutate: (node: DocLike) => void) {
  const store = useStore.getState();
  const tab = store.tabs[tabId];
  if (!tab?.docJSON) return;
  const doc = JSON.parse(JSON.stringify(tab.docJSON)) as DocLike;
  const walk = (n: DocLike) => {
    if (n.type === 'taskItem' && n.attrs?.id === id) mutate(n);
    n.content?.forEach(walk);
  };
  walk(doc);
  store.setTabDoc(tabId, doc);
}

function writeTextToPersistedDoc(tabId: ID, id: ID, text: string) {
  mutatePersistedTask(tabId, id, (n) => {
    const para = n.content?.[0];
    if (para) para.content = text ? [{ type: 'text', text }] : [];
  });
}
