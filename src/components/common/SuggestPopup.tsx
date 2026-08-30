// The suggestion list itself, with no opinion about what is being typed into.
//
// Lifted out of TaskTitleSuggest (NOTES_SPLIT_PLAN §N1) so the doc's title widget and the
// quick-add line show the same popup rather than two that drift apart. Everything host-specific —
// reading the caret, rewriting the text, what a pick does — stays with the caller; this renders a
// list and reports clicks.

import type { Member } from '../../types';

export interface SuggestItem {
  key: string;
  label: string;
  /** Command items only: the group header rendered when the list crosses into a new category. */
  category?: string;
}

export function SuggestPopup({ kind, items, highlight, x, y, onHighlight, onPick }: {
  kind: 'mention' | 'command';
  /** Members for a mention popup, command items for a command one. */
  items: (Member | SuggestItem)[];
  highlight: number;
  x: number;
  y: number;
  onHighlight: (i: number) => void;
  onPick: (i: number) => void;
}) {
  const isMention = kind === 'mention';
  const nodes: React.ReactNode[] = [];
  let prevCategory: string | null = null;

  items.forEach((m, i) => {
    // A header whenever the (already relevance-sorted) list crosses into a new category — never
    // reorders anything, just annotates transitions as they occur.
    if (!isMention) {
      const category = (m as SuggestItem).category ?? '';
      if (category !== prevCategory) {
        nodes.push(<li key={`cat-${category}`} className="today-suggest-cat" aria-hidden>{category}</li>);
        prevCategory = category;
      }
    }
    const key = isMention ? (m as Member).id : (m as SuggestItem).key;
    nodes.push(
      <li
        key={key}
        className={`today-suggest-item ${i === highlight ? 'active' : ''}`}
        onMouseEnter={() => onHighlight(i)}
        onMouseDown={(e) => {
          e.preventDefault(); // keep focus in the field; the pick rewrites its text
          onPick(i);
        }}
      >
        {isMention ? (
          <>
            <span className="today-suggest-avatar">{(m as Member).name.charAt(0).toUpperCase()}</span>
            <span className="today-suggest-name">{(m as Member).name}</span>
            <span className="today-suggest-sub">{(m as Member).email}</span>
          </>
        ) : (
          <span className="today-suggest-name">{(m as SuggestItem).label}</span>
        )}
      </li>,
    );
  });

  return (
    <ul
      className={`today-suggest ${kind}`}
      style={{ position: 'fixed', top: y, left: x, zIndex: 50 }}
      contentEditable={false}
    >
      {nodes}
    </ul>
  );
}
