import { useEditor, EditorContent, ReactNodeViewRenderer } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { useEffect, useMemo } from 'react';
import { TaskItem } from './extensions/TaskItem';
import { TaskList } from './extensions/TaskList';
import { SyncPlugin } from './extensions/SyncPlugin';
import { TaskNav } from './extensions/TaskNav';
import { TaskItemView } from './TaskItemView';
import { useStore } from '../store';
import { useSession } from '../session/useSession';
import { acquireYRoom, retainYRoom, releaseYRoom } from '../realtime/yProvider';
import { colorForKey } from '../util/avatar';
import { dlog, sid } from '../util/dlog';
import type { ID } from '../types';
import { registerEditor, unregisterEditor } from './registry';

interface Props {
  tabId: ID;
  autoFocus?: boolean;
}

/** True if a stored ProseMirror doc holds anything worth recovering (text or a task ref). Guards
 *  the recovery seed so an empty local snapshot never triggers a pointless (or racy) re-seed. */
function docHasContent(json: unknown): boolean {
  const node = json as { type?: string; text?: string; content?: unknown[] } | null;
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'taskItem') return true;
  if (node.type === 'text' && (node.text ?? '').length > 0) return true;
  return Array.isArray(node.content) && node.content.some(docHasContent);
}

export function TabEditor({ tabId, autoFocus }: Props) {
  const setTabDoc = useStore((s) => s.setTabDoc);
  const user = useSession((s) => s.user);

  // One shared Y.Doc + socket-multiplexed provider per board, from a module cache that survives
  // React StrictMode's mount→unmount→remount and transient editor re-creation. acquire (render)
  // gets-or-creates the live room; retain/release (effect) refcount it so it's torn down only
  // after the last user leaves. The document lives in the Y.Doc (authoritative, persisted
  // server-side) — NOT in a `content` prop.
  const { doc, provider } = useMemo(() => acquireYRoom(tabId), [tabId]);

  // Freeze the local snapshot's doc for THIS tab at mount — before the editor's own onUpdate (which
  // fires on the initial Yjs sync) can overwrite tabs[tabId].docJSON with the empty synced content.
  // This frozen copy is the recovery source for a board the server lost; reading it live would risk
  // the empty-sync overwrite landing first and erasing the only surviving copy. Keyed on tabId so a
  // tab switch recaptures. Reading the store during render is a plain get (no subscription).
  const recoverySource = useMemo(() => useStore.getState().tabs[tabId]?.docJSON ?? null, [tabId]);

  useEffect(() => {
    retainYRoom(tabId);
    return () => releaseYRoom(tabId);
  }, [tabId]);

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          bulletList: false,
          orderedList: false,
          listItem: false,
          codeBlock: false,
          heading: { levels: [1, 2, 3] },
          undoRedo: false, // Collaboration supplies Yjs-based undo/redo instead
        }),
        TaskList,
        TaskItem.extend({
          addNodeView() {
            // stopEvent: the title lives in a contentEditable widget inside this atom's node view;
            // ProseMirror must NOT handle its keyboard/selection (the widget owns them). See
            // TaskItemView + TASKS_AS_ENTITIES.md P2.
            return ReactNodeViewRenderer(TaskItemView, { stopEvent: () => true });
          },
        }).configure({ tabId }),
        SyncPlugin.configure({ tabId }),
        TaskNav,
        Collaboration.configure({ document: doc, field: 'default' }),
        CollaborationCaret.configure({
          provider,
          user: {
            name: user?.email ?? 'Someone',
            color: colorForKey(user?.id ?? user?.email ?? 'anon'),
          },
        }),
      ],
      autofocus: autoFocus ? 'end' : false,
      onUpdate({ editor }) {
        // Yjs is authoritative and persisted server-side; we only mirror into the local store so
        // this tab's board preview stays current. There is NO server doc-save (see persist.ts).
        dlog('editor', `onUpdate board=${sid(tabId)} empty=${editor.isEmpty} → setTabDoc (local preview only)`);
        setTabDoc(tabId, editor.getJSON());
      },
    },
    [tabId, doc, provider],
  );

  useEffect(() => {
    if (!editor) return;
    dlog('editor', `editor MOUNTED board=${sid(tabId)} (recoverySource=${docHasContent(recoverySource) ? 'has content' : 'empty'})`);
    registerEditor(tabId, editor);
    return () => unregisterEditor(tabId, editor);
  }, [editor, tabId, recoverySource]);

  // Legacy migration: the server grants a one-time seed of pre-CRDT content. Writing it into the
  // editor flows the old content into the (empty) Y.Doc, which then syncs + persists.
  useEffect(() => {
    if (!editor) return;
    return provider.onSeedReady((docJSON) => {
      if (docJSON) editor.commands.setContent(docJSON as Record<string, unknown>);
    });
  }, [editor, provider]);

  // Recovery (companion to the server durability fix): if the server signals this board never
  // persisted a doc, the creator's lost first-session content may survive only in THIS browser's
  // offline snapshot. Re-seed the empty Y.Doc from the local store's docJSON so it syncs + persists
  // (now durably, since the tabs row exists by the time a returning user reopens the board).
  useEffect(() => {
    if (!editor) return;
    return provider.onRecoverReady(() => {
      if (editor.isDestroyed || !editor.isEmpty) return; // never clobber a non-empty doc
      if (docHasContent(recoverySource)) {
        editor.commands.setContent(recoverySource as Record<string, unknown>);
      }
    });
  }, [editor, provider, recoverySource]);

  // The @/slash suggestion engine now lives per-title-widget (TaskTitleSuggest, rendered by
  // TaskItemView), since the title is a contentEditable bound to the entity — not ProseMirror text.
  if (!editor) return null;
  return <EditorContent editor={editor} className="prose-editor" />;
}
