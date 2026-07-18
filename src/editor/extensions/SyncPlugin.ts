import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Transaction, EditorState } from '@tiptap/pm/state';
import { isChangeOrigin } from '@tiptap/extension-collaboration';
import { nanoid } from 'nanoid';
import { useStore } from '../../store';
import type { ID } from '../../types';

// TASKS_AS_ENTITIES.md P2: task text no longer lives in the doc, so this plugin no longer mirrors
// text or strips tokens. Its remaining job is EXISTENCE reconciliation between the doc's task-ref
// atoms and the store rows:
//   - assign an id to any ref atom that lacks one (paste / programmatic insert),
//   - ensure a store row exists for every ref atom (create an empty one if missing),
//   - GC: soft-delete a row whose ref atom we've SEEN in this doc but that is now gone.
// The full row↔ref invariant is enforced server-side in the P4 reconcile engine; this keeps the
// open editor's local store consistent so all views render coherently.

export interface SyncPluginOptions {
  tabId: ID;
}

const key = new PluginKey('do-sync');

function scanRefIds(state: EditorState): { ids: Set<string>; needsId: number[] } {
  const ids = new Set<string>();
  const needsId: number[] = [];
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'taskItem') return true;
    const existing = (node.attrs.id as string | null) ?? null;
    if (!existing || ids.has(existing)) needsId.push(pos);
    else ids.add(existing);
    return true;
  });
  return { ids, needsId };
}

export const SyncPlugin = Extension.create<SyncPluginOptions>({
  name: 'doSync',
  addOptions() {
    return { tabId: '' };
  },
  addProseMirrorPlugins() {
    const tabId = this.options.tabId;
    // Ref ids observed in THIS doc. GC (soft-delete) is scoped to this set so a row loaded from
    // /api/state that hasn't appeared in the doc yet is never deleted (the "refresh wipes the
    // board" guard, carried over from the legacy plugin).
    const everSeen = new Set<ID>();
    return [
      new Plugin({
        key,
        appendTransaction: (transactions, _oldState, newState) => {
          if (!tabId) return null;
          // Remote (Yjs) edits: the ORIGIN client already assigned ids + mirrored rows over the
          // entity channel. Re-running that here would fight the CRDT + entity sync. We still learn
          // the ref ids (to seed `everSeen`) but never re-id or GC on a remote transaction.
          const remote = transactions.some((t) => isChangeOrigin(t) || t.getMeta('externalEdit'));

          const { ids, needsId } = scanRefIds(newState);

          let tr: Transaction | null = null;
          if (!remote && needsId.length) {
            tr = newState.tr;
            for (const pos of needsId) {
              const node = tr.doc.nodeAt(pos);
              if (!node || node.type.name !== 'taskItem') continue;
              const id = `t_${nanoid(8)}`;
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, id });
              ids.add(id);
            }
          }

          const refIds = [...ids];
          // Mirror EXISTENCE into the store off-transaction (never mutate zustand mid-dispatch).
          queueMicrotask(() => {
            const store = useStore.getState();
            for (const id of refIds) {
              everSeen.add(id);
              // A ref with no row (paste / undo re-insert) gets an empty backing row so the entity
              // exists everywhere. Existing rows are untouched (upsertTask spreads the existing).
              if (!store.tasks[id]) store.upsertTask({ id, homeTabId: tabId, text: '' });
            }
            if (!remote) {
              const present = new Set(refIds);
              for (const t of Object.values(store.tasks)) {
                if (t.homeTabId === tabId && everSeen.has(t.id) && !present.has(t.id)) {
                  store.deleteTask(t.id); // ref removed from the doc → soft-delete the row
                }
              }
            }
          });

          return tr;
        },
      }),
    ];
  },
});
