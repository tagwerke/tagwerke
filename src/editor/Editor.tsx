import { useEditor, EditorContent, ReactNodeViewRenderer } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useRef } from 'react';
import { TaskItem } from './extensions/TaskItem';
import { TaskList } from './extensions/TaskList';
import { SyncPlugin } from './extensions/SyncPlugin';
import { TaskItemView } from './TaskItemView';
import { useStore } from '../store';
import type { ID } from '../types';
import { registerEditor, unregisterEditor } from './registry';

interface Props {
  tabId: ID;
  autoFocus?: boolean;
}

export function TabEditor({ tabId, autoFocus }: Props) {
  const docJSON = useStore((s) => s.tabs[tabId]?.docJSON);
  const setTabDoc = useStore((s) => s.setTabDoc);
  const lastSavedJSON = useRef<string>('');

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          bulletList: false,
          orderedList: false,
          listItem: false,
          codeBlock: false,
          heading: { levels: [1, 2, 3] },
        }),
        TaskList,
        TaskItem.extend({
          addNodeView() {
            return ReactNodeViewRenderer(TaskItemView);
          },
        }),
        SyncPlugin.configure({ tabId }),
      ],
      content: docJSON || { type: 'doc', content: [{ type: 'paragraph' }] },
      autofocus: autoFocus ? 'end' : false,
      onUpdate({ editor }) {
        const json = editor.getJSON();
        const str = JSON.stringify(json);
        if (str !== lastSavedJSON.current) {
          lastSavedJSON.current = str;
          setTabDoc(tabId, json);
        }
      },
    },
    [tabId]
  );

  useEffect(() => {
    if (!editor) return;
    registerEditor(tabId, editor);
    return () => unregisterEditor(tabId, editor);
  }, [editor, tabId]);

  if (!editor) return null;
  return <EditorContent editor={editor} className="prose-editor" />;
}
