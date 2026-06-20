import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Transaction, EditorState } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { nanoid } from 'nanoid';
import { useStore } from '../../store';
import { extractTokens } from '../../util/parse';
import { applyStripOps, stripOpForLine, type StripOp } from '../taskItemDoc';
import type { ID, Task } from '../../types';

export interface SyncPluginOptions {
  tabId: ID;
}

const key = new PluginKey('do-sync');

interface ScannedItem {
  id: string;
  pos: number;
  rawText: string;
  done: boolean;
  cursorInside: boolean;
}

function scanDoc(state: EditorState): { items: ScannedItem[]; needsId: { pos: number; node: PMNode }[] } {
  const items: ScannedItem[] = [];
  const needsId: { pos: number; node: PMNode }[] = [];
  const seenIds = new Set<string>();
  const sel = state.selection;
  state.doc.descendants((node, pos) => {
    if (node.type.name === 'taskItem') {
      const existingId: string | null = node.attrs.id ?? null;
      // Reassign if id is missing OR duplicate (splitListItem copies attrs).
      if (!existingId || seenIds.has(existingId)) {
        needsId.push({ pos, node });
      } else {
        seenIds.add(existingId);
      }
      const from = pos;
      const to = pos + node.nodeSize;
      const cursorInside = sel.from >= from && sel.from <= to;
      const para = node.firstChild;
      const text = para?.textContent ?? '';
      items.push({
        id: existingId ?? '',
        pos,
        rawText: text,
        done: !!node.attrs.done,
        cursorInside,
      });
    }
    return true;
  });
  return { items, needsId };
}

export const SyncPlugin = Extension.create<SyncPluginOptions>({
  name: 'doSync',
  addOptions() {
    return { tabId: '' };
  },
  addProseMirrorPlugins() {
    const tabId = this.options.tabId;
    return [
      new Plugin({
        key,
        appendTransaction: (transactions, _oldState, newState) => {
          if (!tabId) return null;
          const externalEdit = transactions.some((t) => t.getMeta('externalEdit'));
          const { items, needsId } = scanDoc(newState);

          let tr: Transaction | null = null;

          if (needsId.length) {
            tr = tr ?? newState.tr;
            for (const { pos, node } of needsId) {
              const id = nanoid(8);
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, id });
              // Update the corresponding scanned item so the mirror pass sees the fresh id.
              const scanned = items.find((it) => it.pos === pos);
              if (scanned) scanned.id = id;
            }
          }

          // Strip tokens from lines where cursor is NOT inside (commit).
          // Walk back-to-front so positions stay valid.
          if (!externalEdit) {
            const stripOps: StripOp[] = [];
            for (const it of items) {
              if (it.cursorInside) continue;
              const op = stripOpForLine(it.pos, it.rawText, newState.doc);
              if (op) stripOps.push(op);
            }
            if (stripOps.length) {
              tr = tr ?? newState.tr;
              applyStripOps(tr, stripOps, newState.schema);
            }
          }

          // Mirror text + metadata to store. Defer via queueMicrotask to avoid
          // mutating zustand state inside an in-flight transaction.
          const snapshot = items.map((it) => ({
            id: it.id || '',
            pos: it.pos,
            rawText: it.rawText,
            done: it.done,
            cursorInside: it.cursorInside,
          }));

          queueMicrotask(() => {
            const store = useStore.getState();
            const seen = new Set<ID>();
            const updates: Record<ID, Task> = { ...store.tasks };
            for (const it of snapshot) {
              if (!it.id) continue;
              const parsed = extractTokens(it.rawText);
              const text = parsed.text;
              const existing = updates[it.id];
              const merged: Task = {
                id: it.id,
                homeTabId: tabId,
                text,
                done: parsed.done ?? it.done ?? existing?.done,
                date: parsed.date ?? existing?.date,
                priority: parsed.priority ?? existing?.priority,
                owner: parsed.owner ?? existing?.owner,
              };
              // Only update if changed
              if (
                !existing ||
                existing.text !== merged.text ||
                existing.done !== merged.done ||
                existing.date !== merged.date ||
                existing.priority !== merged.priority ||
                existing.owner !== merged.owner ||
                existing.homeTabId !== merged.homeTabId
              ) {
                updates[it.id] = merged;
              }
              seen.add(it.id);
            }
            // Drop tasks whose home is this tab but are no longer in the doc
            for (const t of Object.values(store.tasks)) {
              if (t.homeTabId === tabId && !seen.has(t.id)) delete updates[t.id];
            }
            useStore.setState(() => ({ tasks: { ...updates } }));
          });

          return tr;
        },
      }),
    ];
  },
});
