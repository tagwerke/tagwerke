import { useEditor, EditorContent, ReactNodeViewRenderer } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useRef } from 'react';
import { TaskItem } from './extensions/TaskItem';
import { TaskList } from './extensions/TaskList';
import { TaskItemView } from './TaskItemView';
import { BlockHeader, blockHeaderKey } from './extensions/BlockHeader';
import { TodaySyncPlugin } from './extensions/TodaySyncPlugin';
import { TodaySuggestionOverlay } from './TodaySuggestionOverlay';
import { useStore } from '../store';
import { registerEditor, unregisterEditor } from './registry';
import type { ID } from '../types';

interface Props { tabId: ID; autoFocus?: boolean }

export function TodayEditor({ tabId, autoFocus }: Props) {
  const docJSON = useStore((s) => s.tabs[tabId]?.docJSON);
  const setTabDoc = useStore((s) => s.setTabDoc);
  const tabs = useStore((s) => s.tabs);
  const projects = useStore((s) => s.projects);
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
        BlockHeader,
        TodaySyncPlugin,
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
    [tabId],
  );

  // Register so external editors / TaskRow lookups can find taskItems here too.
  useEffect(() => {
    if (!editor) return;
    registerEditor(tabId, editor);
    return () => unregisterEditor(tabId, editor);
  }, [editor, tabId]);

  // When tabs/projects change (rename, recolor, new tab created), nudge the
  // BlockHeader plugin to recompute regions + decorations.
  useEffect(() => {
    if (!editor) return;
    editor.view.dispatch(editor.state.tr.setMeta('todayRecompute', true));
    // suppress: only nudge on the relevant slices.
    void blockHeaderKey; // keep import used
  }, [editor, tabs, projects]);

  if (!editor) return null;
  return (
    <>
      <EditorContent editor={editor} className="prose-editor today-editor" />
      <TodaySuggestionOverlay editor={editor} />
    </>
  );
}
