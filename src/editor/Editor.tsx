import { useEditor, EditorContent, ReactNodeViewRenderer } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { useCallback, useEffect, useMemo } from 'react';
import * as Y from 'yjs';
import { TaskItem } from './extensions/TaskItem';
import { TaskList } from './extensions/TaskList';
import { SyncPlugin } from './extensions/SyncPlugin';
import { TaskItemView } from './TaskItemView';
import { SuggestionOverlay, type ResolveHomeTab } from './SuggestionOverlay';
import { useStore } from '../store';
import { useSession } from '../session/useSession';
import { YSocketProvider } from '../realtime/yProvider';
import type { ID } from '../types';
import { registerEditor, unregisterEditor } from './registry';

interface Props {
  tabId: ID;
  autoFocus?: boolean;
}

/** Stable per-identity cursor color from a string key. */
function colorFor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 70% 45%)`;
}

export function TabEditor({ tabId, autoFocus }: Props) {
  const setTabDoc = useStore((s) => s.setTabDoc);
  const user = useSession((s) => s.user);

  // One Y.Doc + socket-multiplexed provider per open board. Recreated when the board changes;
  // the effect below destroys the previous pair. The document's content now lives in the
  // Y.Doc (authoritative, persisted server-side) — NOT in a `content` prop.
  const { doc, provider } = useMemo(() => {
    const d = new Y.Doc();
    return { doc: d, provider: new YSocketProvider(tabId, d) };
  }, [tabId]);

  useEffect(
    () => () => {
      provider.destroy();
      doc.destroy();
    },
    [doc, provider],
  );

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
            return ReactNodeViewRenderer(TaskItemView);
          },
        }),
        SyncPlugin.configure({ tabId }),
        Collaboration.configure({ document: doc, field: 'default' }),
        CollaborationCaret.configure({
          provider,
          user: {
            name: user?.email ?? 'Someone',
            color: colorFor(user?.id ?? user?.email ?? 'anon'),
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

  // In a normal tab every task is homed to this tab, so the @ picker scopes to it.
  const resolveHomeTab = useCallback<ResolveHomeTab>(() => tabId, [tabId]);

  if (!editor) return null;
  return (
    <>
      <EditorContent editor={editor} className="prose-editor" />
      <SuggestionOverlay editor={editor} resolveHomeTab={resolveHomeTab} />
    </>
  );
}
