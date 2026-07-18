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
import type { ID } from '../types';
import { registerEditor, unregisterEditor } from './registry';

interface Props {
  tabId: ID;
  autoFocus?: boolean;
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
        setTabDoc(tabId, editor.getJSON());
      },
    },
    [tabId, doc, provider],
  );

  useEffect(() => {
    if (!editor) return;
    registerEditor(tabId, editor);
    return () => unregisterEditor(tabId, editor);
  }, [editor, tabId]);

  // Legacy migration: the server grants a one-time seed of pre-CRDT content. Writing it into the
  // editor flows the old content into the (empty) Y.Doc, which then syncs + persists.
  useEffect(() => {
    if (!editor) return;
    return provider.onSeedReady((docJSON) => {
      if (docJSON) editor.commands.setContent(docJSON as Record<string, unknown>);
    });
  }, [editor, provider]);

  // The @/slash suggestion engine now lives per-title-widget (TaskTitleSuggest, rendered by
  // TaskItemView), since the title is a contentEditable bound to the entity — not ProseMirror text.
  if (!editor) return null;
  return <EditorContent editor={editor} className="prose-editor" />;
}
