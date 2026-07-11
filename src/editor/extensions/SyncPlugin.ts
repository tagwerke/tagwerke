import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Transaction, EditorState } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { isChangeOrigin } from '@tiptap/extension-collaboration';
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
    // Task ids this editor has actually observed in the doc. GC (delete-from-store) is scoped to
    // this set so a task loaded from `/api/state` that has NOT yet appeared in the doc is never
    // deleted. This is what makes a fresh, still-empty Y.Doc on mount (before its Yjs sync/seed
    // arrives) safe: the empty scan sees nothing, `everSeen` is empty, so no task is GC'd — instead
    // of soft-deleting every task on the board (the "refresh wipes the board" bug). A task is only
    // GC'd once we've seen it in the doc AND it later disappears (a genuine user deletion).
    const everSeen = new Set<ID>();
    return [
      new Plugin({
        key,
        appendTransaction: (transactions, _oldState, newState) => {
          if (!tabId) return null;
          // Yjs-applied (remote) edits: the ORIGIN client already assigned task ids, stripped
          // tokens, and mirrored the task rows — which reach us over the entity channel, not the
          // doc. Re-running any of that here would fight the CRDT (double id churn) and the entity
          // sync. So a remote transaction is a full no-op. (Legacy `externalEdit` too.)
          if (transactions.some((t) => isChangeOrigin(t) || t.getMeta('externalEdit'))) {
            return null;
          }
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
          {
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
              // Status/assignee/position are entity-only — preserve them by spreading existing.
              // A `[x]`/`[ ]` checkbox token still maps to status (paste/markdown compatibility).
              const status =
                parsed.done != null ? (parsed.done ? 'done' : 'todo') : existing?.status ?? 'todo';
              const merged: Task = {
                ...existing,
                id: it.id,
                homeTabId: tabId,
                text,
                status,
                date: parsed.date ?? existing?.date,
                priority: parsed.priority ?? existing?.priority,
                owner: parsed.owner ?? existing?.owner,
                position: existing?.position ?? 0,
                done: status === 'done',
              };
              // Only update if a plugin-owned field changed.
              if (
                !existing ||
                existing.text !== merged.text ||
                (existing.status ?? 'todo') !== merged.status ||
                existing.date !== merged.date ||
                existing.priority !== merged.priority ||
                existing.owner !== merged.owner ||
                existing.homeTabId !== merged.homeTabId
              ) {
                updates[it.id] = merged;
              }
              seen.add(it.id);
              everSeen.add(it.id);
            }
            // GC: drop tasks homed on this tab that we've SEEN in the doc before but that are now
            // gone (a genuine user deletion). Scoping to `everSeen` is what prevents a not-yet-synced
            // empty doc from soft-deleting every task on the board — a task we've never observed in
            // the doc (still loading from the server) is left untouched, not deleted.
            for (const t of Object.values(store.tasks)) {
              if (t.homeTabId === tabId && everSeen.has(t.id) && !seen.has(t.id)) delete updates[t.id];
            }
            useStore.setState(() => ({ tasks: { ...updates } }));
          });

          return tr;
        },
      }),
    ];
  },
});
