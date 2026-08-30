import { useEditor, EditorContent, ReactNodeViewRenderer } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TaskMention } from './extensions/TaskMention';
import { TaskMentionView } from './TaskMentionView';
import { useStore } from '../store';
import type { ID } from '../types';

interface Props { tabId: ID }

/** Read-only preview of a board's NOTES, used on the board card. It renders the same mention
 *  node the editor does, so a preview of a converted task list reads as the titles it links to
 *  rather than as a row of blanks. */
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
        TaskMention.extend({
          addNodeView() {
            return ReactNodeViewRenderer(TaskMentionView);
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
