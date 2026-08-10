import { useEffect, useRef, useState } from 'react';

export interface DropdownOption {
  value: string;
  label: string;
  accent?: string;
}

interface Props {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  /** Show a search input above the list when open. */
  searchable?: boolean;
  searchPlaceholder?: string;
  /** Custom ranking for a search query; defaults to label-substring filter over `options`. */
  rank?: (query: string) => DropdownOption[];
}

export function Dropdown({ value, options, onChange, placeholder, searchable, searchPlaceholder, rank }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(() =>
    Math.max(0, options.findIndex((o) => o.value === value))
  );
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const q = query.trim();
  const shown = !searchable || !q
    ? options
    : rank
      ? rank(q)
      : options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase()));

  const selected = options.find((o) => o.value === value);

  const openList = () => {
    setQuery('');
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };

  const pick = (opt: DropdownOption) => {
    onChange(opt.value);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openList();
      }
      return;
    }
    // stopPropagation so Escape closes just the dropdown, not a parent modal
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(shown.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); const o = shown[active]; if (o) pick(o); }
  };

  return (
    <div className={`dd ${open ? 'open' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="dd-trigger"
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {selected ? (
          <span className="dd-trigger-value">
            {selected.accent && <span className="dd-dot" style={{ background: selected.accent }} />}
            {selected.label}
          </span>
        ) : (
          <span className="dd-trigger-placeholder">{placeholder ?? 'select…'}</span>
        )}
        <svg viewBox="0 0 12 12" width="10" height="10" className="dd-caret" aria-hidden>
          <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="dd-panel">
          {searchable && (
            <input
              autoFocus
              className="dd-search"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setActive(0); }}
              onKeyDown={onKeyDown}
              placeholder={searchPlaceholder ?? 'search…'}
              aria-label="search options"
            />
          )}
          <ul className="dd-list" role="listbox">
            {shown.length === 0 && <li className="dd-empty">{q ? 'no matches' : 'no options'}</li>}
            {shown.map((o, i) => (
              <li
                key={o.value}
                role="option"
                aria-selected={o.value === value}
                className={`dd-option ${i === active ? 'is-active' : ''} ${o.value === value ? 'is-selected' : ''}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => { e.preventDefault(); pick(o); }}
              >
                {o.accent && <span className="dd-dot" style={{ background: o.accent }} />}
                <span className="dd-option-label">{o.label}</span>
                {o.value === value && (
                  <svg viewBox="0 0 16 16" width="12" height="12" className="dd-check" aria-hidden>
                    <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
