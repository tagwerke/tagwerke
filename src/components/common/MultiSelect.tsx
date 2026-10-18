// A multi-select dropdown for filters (BOARD_FILTERS_PLAN D1), modelled on the swimatrix
// MultiFilterSelect. The closed field reads "All sprints" when nothing is picked (no filter), the
// first pick when one is, and the first pick plus "+N" for more. Options picked when the panel
// opened float to the top, and that order is frozen for the visit so ticking a row never makes it
// jump out from under the pointer. Past SEARCH_THRESHOLD options the panel gets a search box.
//
// It borrows Dropdown's CSS classes so the two read as one family.

import { useEffect, useMemo, useRef, useState } from 'react';
import { EmptyState } from './EmptyState';

export interface MultiOption {
  value: string;
  label: string;
}

/** Above this many options the panel gets a search box. */
const SEARCH_THRESHOLD = 8;

export function MultiSelect({ options, selected, onChange, noun, label }: {
  options: MultiOption[];
  selected: string[];
  onChange: (selected: string[]) => void;
  /** Plural noun for the empty state: "sprints" → "All sprints". */
  noun: string;
  /** Accessible name for the trigger. */
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  // Snapshot of what was picked when the panel opened; drives the float-to-top order.
  const [pinned, setPinned] = useState<string[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const showSearch = options.length > SEARCH_THRESHOLD;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
    if (pinned.length === 0) return matches;
    return [...matches.filter((o) => pinned.includes(o.value)), ...matches.filter((o) => !pinned.includes(o.value))];
  }, [options, query, pinned]);

  const labelOf = (v: string) => options.find((o) => o.value === v)?.label ?? v;
  const text = selected.length === 0 ? `All ${noun}` : labelOf(selected[0]);
  const extra = selected.length - 1;

  const openPanel = () => {
    setQuery('');
    setPinned(selected);
    setActive(0);
    setOpen(true);
  };

  const toggle = (value: string) => {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPanel(); }
      return;
    }
    // stopPropagation so Escape closes just the panel, not whatever is above it.
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(shown.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter' || (e.key === ' ' && !showSearch)) {
      e.preventDefault();
      const o = shown[active];
      if (o) toggle(o.value);
    }
  };

  return (
    <div className={`dd is-compact ms ${open ? 'open' : ''} ${selected.length ? 'has-value' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="dd-trigger"
        onClick={() => (open ? setOpen(false) : openPanel())}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
      >
        <span className="dd-trigger-value">
          <span className="ms-text">{text}</span>
          {extra > 0 && <span className="ms-extra">+{extra}</span>}
        </span>
        <svg viewBox="0 0 12 12" width="10" height="10" className="dd-caret" aria-hidden>
          <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="dd-panel">
          {showSearch && (
            <input
              autoFocus
              className="dd-search"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setActive(0); }}
              onKeyDown={onKeyDown}
              placeholder={`Search ${noun}…`}
              aria-label={`Search ${noun}`}
            />
          )}
          <ul className="dd-list" role="listbox" aria-multiselectable="true">
            {shown.length === 0 && <EmptyState size="block" as="li">No matches</EmptyState>}
            {shown.map((o, i) => {
              const on = selected.includes(o.value);
              return (
                <li
                  key={o.value}
                  role="option"
                  aria-selected={on}
                  className={`dd-option ${i === active ? 'is-active' : ''} ${on ? 'is-selected' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  // mousedown, not click: the panel keeps focus where it is and stays open.
                  onMouseDown={(e) => { e.preventDefault(); toggle(o.value); }}
                >
                  <span className={`ms-box ${on ? 'is-on' : ''}`} aria-hidden>
                    {on && (
                      <svg viewBox="0 0 16 16" width="10" height="10">
                        <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                  <span className="dd-option-label">{o.label}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
