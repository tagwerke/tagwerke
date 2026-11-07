// The search box with a filter menu behind a button at its right edge. One component for the
// boards page and for inside a board: the box itself is the same, only the filters in the menu
// (its children) differ. The box keeps its own text and reports it after a pause, so typing does
// not re-filter on every keystroke; Esc clears it at once.

import { useEffect, useRef, useState, type ReactNode } from 'react';

const SEARCH_DEBOUNCE_MS = 200;

export function FilterSearch({ query, onQuery, label, menuTitle, menuCount, onClearMenu, children }: {
  /** The committed query. When it changes from outside (a Clear button), the box follows. */
  query: string;
  onQuery: (query: string) => void;
  /** What the box searches, for its tooltip and accessible name. */
  label: string;
  /** Tooltip for the filter button: which filters are behind it. */
  menuTitle: string;
  /** How many of the menu's filters are on; shown on the button, open or not. */
  menuCount: number;
  onClearMenu: () => void;
  /** The menu's rows. */
  children: ReactNode;
}) {
  const [text, setText] = useState(query);
  // Follow the query when it changes from outside (a Clear button): adjusting state while rendering,
  // which React prefers to an effect for this.
  const [seen, setSeen] = useState(query);
  if (query !== seen) {
    setSeen(query);
    setText(query);
  }
  useEffect(() => {
    if (text === query) return;
    const h = setTimeout(() => onQuery(text), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(h);
  }, [text, query, onQuery]);

  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  return (
    <div className="work-search" ref={rootRef}>
      <div className="scope-search work-search-box">
        <label className="work-search-field" title={label}>
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          <input
            type="text"
            value={text}
            placeholder={`${label}…`}
            aria-label={label}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return;
              e.stopPropagation();
              if (text) {
                setText('');
                onQuery('');
              } else {
                e.currentTarget.blur();
              }
            }}
          />
        </label>
        <span className="work-search-rule" aria-hidden />
        <button
          type="button"
          className={`work-filter-btn ${menuOpen ? 'is-open' : ''} ${menuCount ? 'has-value' : ''}`}
          aria-label={menuCount ? `Filters (${menuCount} on)` : 'Filters'}
          title={menuTitle}
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
            <path d="M2 4h7M12 4h2M2 12h3M8 12h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="10.5" cy="4" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="6.5" cy="12" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          {menuCount > 0 && <span className="work-filter-count">{menuCount}</span>}
        </button>
      </div>

      {menuOpen && (
        <div
          className="work-filter-menu"
          role="dialog"
          aria-label="Filters"
          onKeyDown={(e) => {
            // A dropdown inside handles its own Escape first and stops it there.
            if (e.key === 'Escape') { e.stopPropagation(); setMenuOpen(false); }
          }}
        >
          <div className="work-filter-head">
            <span>Filters</span>
            {menuCount > 0 && <button type="button" className="btn tiny ghost" onClick={onClearMenu}>Clear</button>}
          </div>
          {children}
        </div>
      )}
    </div>
  );
}
