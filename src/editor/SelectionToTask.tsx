// "Make a task" — the one gesture that turns thinking into work (NOTES_SPLIT_PLAN §I.6).
//
// Select a sentence in a note, press the button, and it becomes a task; the selected text is
// replaced in place by a mention of it. That replacement is the point: the note keeps reading as
// what you wrote, and now the thing you wrote about exists and can be tracked, without the note
// having to own it.
//
// It is the answer to the question the notes split leaves open — if a note cannot contain tasks,
// how does a thought become one? A note is where thoughts start. If one never graduates, it was
// thinking, and thinking is allowed to stay thinking.

import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { createTaskInBoard } from '../tasks/createTask';
import type { ID } from '../types';

const MAX_TITLE = 200;

export function SelectionToTask({ editor, tabId }: { editor: Editor; tabId: ID }) {
  const [at, setAt] = useState<{ x: number; y: number; text: string } | null>(null);

  useEffect(() => {
    const update = (): void => {
      const { state, view } = editor;
      const { from, to, empty } = state.selection;
      if (empty || !editor.isEditable || !view.hasFocus()) return setAt(null);

      const text = state.doc.textBetween(from, to, ' ').trim();
      // A selection of only a mention or an image has no words to name a task after.
      if (!text) return setAt(null);

      const start = view.coordsAtPos(from);
      const end = view.coordsAtPos(to);
      setAt({ x: Math.min(start.left, end.left), y: Math.min(start.top, end.top) - 40, text });
    };

    editor.on('selectionUpdate', update);
    editor.on('blur', () => setAt(null));
    return () => {
      editor.off('selectionUpdate', update);
    };
  }, [editor]);

  if (!at) return null;

  const make = (): void => {
    const title = at.text.replace(/\s+/g, ' ').slice(0, MAX_TITLE);
    const id = createTaskInBoard(tabId, { text: title });
    // One transaction: the selection goes and the mention arrives in its place, so an undo puts
    // the sentence back in one step rather than leaving a mention with nothing around it.
    editor.chain().focus().deleteSelection().insertContent({ type: 'taskMention', attrs: { id } }).run();
    setAt(null);
  };

  return (
    <div className="selection-bubble" style={{ position: 'fixed', left: at.x, top: at.y, zIndex: 55 }}>
      <button type="button" className="selection-bubble-btn" onMouseDown={(e) => { e.preventDefault(); make(); }}>
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
          <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        Make a task
      </button>
    </div>
  );
}
