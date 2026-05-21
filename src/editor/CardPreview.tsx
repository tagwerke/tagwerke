import { useEditor, EditorContent, ReactNodeViewRenderer } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem } from './extensions/TaskItem';
import { TaskList } from './extensions/TaskList';
import { TaskItemView } from './TaskItemView';
import { useStore } from '../store';
import type { ID } from '../types';

interface Props { tabId: ID }

/** Read-only preview of a tab's doc, used on the board card. */
export function CardPreview({ tabId }: Props) {
  const docJSON = useStore((s) => s.tabs[tabId]?.docJSON);

  const editor = useEditor(
    {
      editable: false,
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
      ],
      content: docJSON || { type: 'doc', content: [{ type: 'paragraph' }] },
    },
    [tabId, JSON.stringify(docJSON ?? null)]
  );
  if (!editor) return null;
  return <EditorContent editor={editor} className="card-preview-body" />;
}
