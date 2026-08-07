// The comment box (COMMENTS_PLAN.md). A plain <textarea> — deliberately not a second rich-text
// surface with its own serialization (§6). What it adds over a bare field is the `@mention`
// autocomplete, which is the same idea as the task title's (`src/editor/TaskTitleSuggest.tsx`)
// against the same board roster, and reuses its ranking and popup styling.
//
// On pick, the `@query` under the caret is replaced by a canonical `@[name](userId)` token
// (shared/mentions.ts). The server re-derives the recipient list from those tokens, so what the
// writer sees mentioned and who actually gets notified cannot drift apart.
//
// Keys: Enter sends, Shift+Enter is a newline, Escape closes the suggestion popup (and, when
// there is none, cancels a reply/edit). While the popup is open the arrow keys and Enter/Tab
// belong to it.

import { useRef, useState } from 'react';
import { useStore } from '../store';
import { rankMembers } from '../editor/suggestEngine';
import { mentionToken } from '../../shared/mentions';
import type { ID, Member } from '../types';

interface Props {
  tabId: ID;
  /** Sent on submit; the parent decides whether that's a new comment, a reply, or an edit. */
  onSubmit(body: string): void;
  /** Escape / Cancel — absent for the always-present main composer. */
  onCancel?: () => void;
  placeholder?: string;
  initialValue?: string;
  submitLabel?: string;
  autoFocus?: boolean;
}

/** The `@query` being typed immediately before the caret, if any. */
function mentionQuery(value: string, caret: number): { query: string; start: number } | null {
  const before = value.slice(0, caret);
  const m = before.match(/(?:^|\s)@(\w*)$/);
  if (!m) return null;
  return { query: m[1] ?? '', start: caret - (m[1] ?? '').length - 1 };
}

export function CommentComposer({
  tabId,
  onSubmit,
  onCancel,
  placeholder = 'Write a comment — @ to mention',
  initialValue = '',
  submitLabel = 'Comment',
  autoFocus = false,
}: Props) {
  const members = useStore((s) => s.membersByBoard[tabId]);
  const [value, setValue] = useState(initialValue);
  const [matches, setMatches] = useState<Member[] | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [anchor, setAnchor] = useState(0); // index of the '@' the popup is completing
  const ref = useRef<HTMLTextAreaElement | null>(null);

  function recompute(next: string, caret: number): void {
    const q = mentionQuery(next, caret);
    if (!q) return setMatches(null);
    const found = rankMembers(members ?? [], q.query);
    setHighlight(0);
    setAnchor(q.start);
    setMatches(found.length ? found : null);
  }

  /** Swap the `@query` under the caret for a real mention token and drop the caret after it. */
  function pick(m: Member): void {
    const el = ref.current;
    const caret = el?.selectionStart ?? value.length;
    const token = `${mentionToken(m.name, m.id)} `;
    const next = value.slice(0, anchor) + token + value.slice(caret);
    setValue(next);
    setMatches(null);
    // Restore focus + caret after React has written the new value back to the textarea.
    requestAnimationFrame(() => {
      const node = ref.current;
      if (!node) return;
      node.focus();
      const pos = anchor + token.length;
      node.setSelectionRange(pos, pos);
    });
  }

  function submit(): void {
    const body = value.trim();
    if (!body) return;
    onSubmit(body);
    setValue('');
    setMatches(null);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (matches) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((h) => Math.min(matches.length - 1, h + 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => Math.max(0, h - 1));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const sel = matches[highlight];
        if (sel) pick(sel);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMatches(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === 'Escape' && onCancel) {
      e.preventDefault();
      onCancel();
    }
  }

  return (
    <div className="comment-composer">
      {matches && (
        <ul className="today-suggest mention comment-suggest" role="listbox">
          {matches.map((m, i) => (
            <li
              key={m.id}
              className={`today-suggest-item ${i === highlight ? 'active' : ''}`}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => {
                e.preventDefault(); // keep focus in the textarea
                pick(m);
              }}
            >
              <span className="today-suggest-avatar">{m.name.charAt(0).toUpperCase()}</span>
              <span className="today-suggest-name">{m.name}</span>
              <span className="today-suggest-sub">{m.email}</span>
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={ref}
        className="comment-input"
        rows={2}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => {
          setValue(e.target.value);
          recompute(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setMatches(null), 120)}
      />
      <div className="comment-composer-actions">
        {onCancel && (
          <button type="button" className="btn ghost tiny" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="button" className="btn tiny" disabled={!value.trim()} onClick={submit}>
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
