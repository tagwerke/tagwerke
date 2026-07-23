// A "+" button on every empty paragraph, so making a task never requires knowing the "- " gesture
// (typed markdown syntax nobody guesses on a blank board). Purely additive: it's a widget
// decoration next to an empty line, and disappears the instant that line gains any text, since
// `decorations()` recomputes from the live doc on every transaction and simply stops matching a
// paragraph once its content is non-empty — no separate "hide" logic needed.
//
// Reuses createTaskAtParagraph — the exact same transaction the "- " input rule already produces,
// so this is a new way to trigger an already-proven document change, not a new kind of change.

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { createTaskAtParagraph } from '../createTaskAt';

function buildButton(view: EditorView, getPos: () => number | undefined): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pm-add-task-btn';
  btn.contentEditable = 'false';
  btn.setAttribute('aria-label', 'Add a task');
  btn.title = 'Add a task';
  btn.textContent = '+';
  // mousedown (not click), preventDefault — the same pattern TaskTitleSuggest's popup picks use,
  // so the browser's default focus/selection change doesn't run before our handler does.
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const pos = getPos();
    if (pos == null) return;
    // Re-check emptiness at click time: decorations are computed from the doc as of the last
    // render, and a concurrent remote edit could have added text to this exact line a moment ago.
    const $pos = view.state.doc.resolve(pos);
    if ($pos.parent.type.name !== 'paragraph' || $pos.parent.content.size > 0) return;
    createTaskAtParagraph(view, pos);
  });
  return btn;
}

export const EmptyLineAdd = Extension.create({
  name: 'emptyLineAdd',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('emptyLineAdd'),
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (node.type.name === 'paragraph' && node.content.size === 0) {
                decorations.push(Decoration.widget(pos + 1, buildButton, { side: -1 }));
              }
            });
            return decorations.length ? DecorationSet.create(state.doc, decorations) : null;
          },
        },
      }),
    ];
  },
});
