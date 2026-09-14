// One commitment read out of a document, as a reviewable row (CONTRACT_TO_PROJECT_PLAN rung 3).
//
// The single rule this file exists to enforce: THE QUOTE IS ALWAYS ON SCREEN. Not on hover, not in
// a tooltip, not behind a chevron. It is the only reason anyone should believe the line above it,
// and the comments work already taught this codebase what hover-only affordances do on a phone
// (COMMENTS_PLAN §8). The expander here reveals the surrounding paragraph — strictly more than the
// quote, never the quote itself.
//
// Everything else on the row is secondary and looks it: the status, the model's own confidence,
// the mark that says a person has been here. Confidence in particular is advisory and NEVER a
// filter — an item hidden for scoring badly is an item nobody reviews, which is the exact failure
// this panel is built to prevent.

import { useState } from 'react';
import type { DocumentItem } from '../../types';

/** How much of the document to show on either side of a quote. Enough for the sentence before and
 *  after — the point is to prove the quote isn't cherry-picked, not to reproduce the contract. */
const CONTEXT_CHARS = 320;

interface ContextWindow {
  before: string;
  hit: string;
  after: string;
  atStart: boolean;
  atEnd: boolean;
}

/**
 * Find the quote inside the document text and cut a window around it.
 *
 * `sourceOffset` is preferred over searching, because the server recorded it from a
 * whitespace-NORMALISED match (§4.5): the stored text may differ from the quote by a line break or
 * a double space, so `indexOf` can legitimately fail on a quote that is genuinely there. The offset
 * still points at the right place, so the highlight is taken from the text at that offset rather
 * than from the quote string, and its end is run forward to the next word break so a collapsed
 * space can't leave half a word outside the mark.
 *
 * Null means we could not place it at all — which the row says plainly instead of showing a
 * confident window of the wrong paragraph.
 */
function locate(text: string, quote: string, offset?: number): ContextWindow | null {
  let start = -1;
  if (typeof offset === 'number' && offset >= 0 && offset < text.length) start = offset;
  if (start < 0) {
    const idx = text.indexOf(quote);
    if (idx >= 0) start = idx;
  }
  if (start < 0) return null;

  let end = Math.min(text.length, start + quote.length);
  const wordLimit = Math.min(text.length, end + 40);
  while (end < wordLimit && /\S/.test(text[end])) end++;

  const from = Math.max(0, start - CONTEXT_CHARS);
  const to = Math.min(text.length, end + CONTEXT_CHARS);
  let before = text.slice(from, start);
  let after = text.slice(end, to);
  // Start the window at a word break so it doesn't open mid-word.
  if (from > 0) before = before.replace(/^\S*\s/, '');
  if (to < text.length) after = after.replace(/\s\S*$/, '');

  return { before, hit: text.slice(start, end), after, atStart: from === 0, atEnd: to === text.length };
}

interface Props {
  item: DocumentItem;
  /** Viewers read the list; they do not review it. */
  editable: boolean;
  /** The document's full text, once the panel has fetched it. Null = not here (yet). */
  text: string | null;
  /** The text can't be had at all — a failed fetch, or a document whose text is gone. */
  textUnavailable: boolean;
  /** Asks the panel to fetch the text; called only when someone actually opens the context. */
  onNeedText: () => void;
  onStatus: (status: 'accepted' | 'rejected') => void;
  onEdit: (patch: { text?: string; dueDate?: string | null }) => void;
}

export function ItemRow({ item, editable, text, textUnavailable, onNeedText, onStatus, onEdit }: Props) {
  const [showContext, setShowContext] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const [draftDate, setDraftDate] = useState(item.dueDate ?? '');

  // A date row whose date is worth correcting; every other kind is just text.
  const dated = item.kind === 'date' || !!item.dueDate;

  function openEditor() {
    setDraft(item.text);
    setDraftDate(item.dueDate ?? '');
    setEditing(true);
  }

  function save() {
    const patch: { text?: string; dueDate?: string | null } = {};
    const trimmed = draft.trim();
    if (trimmed && trimmed !== item.text) patch.text = trimmed;
    if (dated && draftDate !== (item.dueDate ?? '')) patch.dueDate = draftDate || null;
    if (patch.text !== undefined || patch.dueDate !== undefined) onEdit(patch);
    setEditing(false);
  }

  function toggleContext() {
    if (!showContext) onNeedText();
    setShowContext((v) => !v);
  }

  const ctx = showContext && text ? locate(text, item.sourceQuote, item.sourceOffset) : null;

  return (
    <li className={`doc-item is-${item.status}`}>
      <div className="doc-item-row">
        <div className="doc-item-body">
          {editing ? (
            <div className="doc-item-editor">
              <textarea
                className="doc-item-input"
                value={draft}
                rows={2}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                aria-label="What this commitment says"
              />
              {dated && (
                <input
                  type="date"
                  className="doc-item-date-input"
                  value={draftDate}
                  onChange={(e) => setDraftDate(e.target.value)}
                  aria-label="Date"
                />
              )}
              <div className="doc-item-editor-actions">
                <button type="button" className="btn ghost tiny" onClick={() => setEditing(false)}>Cancel</button>
                <button type="button" className="btn primary tiny" onClick={save}>Save</button>
              </div>
            </div>
          ) : (
            <p className="doc-item-text">{item.text}</p>
          )}

          <div className="doc-item-tags">
            {item.dueDate && !editing && <span className="doc-item-due">{item.dueDate}</span>}
            {item.status !== 'proposed' && (
              <span className={`doc-item-state is-${item.status}`}>{item.status === 'accepted' ? 'accepted' : 'rejected'}</span>
            )}
            {/* The mark that makes the list worth more the longer it lives: a person has been here,
                and re-running extraction will leave this row exactly as they left it (D7). */}
            {item.editedAt && (
              <span className="doc-item-human" title="A person reviewed this. Running the extraction again will not change it.">
                checked by a person
              </span>
            )}
            {typeof item.confidence === 'number' && (
              <span
                className="doc-item-confidence"
                title="The model's own confidence. Advisory only — nothing is ever hidden for scoring low."
              >
                {Math.round(item.confidence * 100)}%
              </span>
            )}
          </div>

          {/* Plain text, not a button: a reader should be able to select these words and search for
              them in the real file, and wrapping them in a control makes that fight the browser. */}
          <blockquote className="doc-item-quote">“{item.sourceQuote}”</blockquote>

          <button
            type="button"
            className="doc-item-cite"
            onClick={toggleContext}
            aria-expanded={showContext}
          >
            {showContext ? 'Hide the surrounding text' : 'Show the surrounding text'}
          </button>

          {showContext && (
            <div className="doc-item-context">
              {textUnavailable ? (
                <p className="doc-item-context-note">
                  The stored text for this document isn’t available, so the surrounding wording can’t be shown. The file
                  itself still opens from the top of this panel.
                </p>
              ) : text === null ? (
                <p className="doc-item-context-note">Fetching the document text…</p>
              ) : ctx ? (
                <p className="doc-item-context-text">
                  {ctx.atStart ? '' : '…'}
                  {ctx.before}
                  <mark>{ctx.hit}</mark>
                  {ctx.after}
                  {ctx.atEnd ? '' : '…'}
                </p>
              ) : (
                <p className="doc-item-context-note">
                  This quote couldn’t be placed in the stored text — it may have been re-read since. Check it against the
                  file itself.
                </p>
              )}
            </div>
          )}
        </div>

        {editable && !editing && (
          <div className="doc-item-actions">
            {/* Accept and reject are a two-state toggle rather than three: the API has no way back
                to 'proposed' (§3), so the escape from a mis-tap is the other button, and both stay
                live whatever the current state is. */}
            <button
              type="button"
              className={`doc-item-btn accept ${item.status === 'accepted' ? 'is-on' : ''}`}
              aria-pressed={item.status === 'accepted'}
              aria-label="Accept this commitment"
              title="Accept — yes, this is in the document and it's ours"
              onClick={() => onStatus('accepted')}
            >
              ✓
            </button>
            <button
              type="button"
              className={`doc-item-btn reject ${item.status === 'rejected' ? 'is-on' : ''}`}
              aria-pressed={item.status === 'rejected'}
              aria-label="Reject this commitment"
              title="Reject — this isn't a commitment, or it's been read wrong"
              onClick={() => onStatus('rejected')}
            >
              ✗
            </button>
            <button
              type="button"
              className="doc-item-btn edit"
              aria-label="Edit the wording"
              title="Edit the wording (the quote below stays as the document has it)"
              onClick={openEditor}
            >
              ✎
            </button>
          </div>
        )}
      </div>
    </li>
  );
}
