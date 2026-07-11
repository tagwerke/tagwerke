// A styled "lookup" combobox for finding a workspace user by email (ServiceNow-style): a search
// field with a magnifier and a results dropdown. It shows NOTHING until you type — the list is a
// server-side search (api.users.lookup, ≥2 chars), never a bulk directory. Selecting a row fills
// the bound value; the parent owns what happens next (here: the Add button).

import { useEffect, useRef, useState } from 'react';
import { api, type UserLookupResult } from '../api/client';

interface Props {
  value: string;
  onChange: (email: string) => void;
  /** Lowercased emails to hide from results (e.g. people already on the board). */
  exclude?: Set<string>;
  disabled?: boolean;
  placeholder?: string;
}

export function EmailLookup({ value, onChange, exclude, disabled, placeholder }: Props) {
  const [results, setResults] = useState<UserLookupResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const reqId = useRef(0);

  // Debounced server search on the typed query. All state updates happen inside the timer (never
  // synchronously in the effect body), and a request-id guard drops any response a newer keystroke
  // has superseded. Below the threshold the timer just clears — no bulk list is ever fetched.
  useEffect(() => {
    if (!open) return;
    const q = value.trim();
    const id = ++reqId.current;
    const t = setTimeout(() => {
      if (q.length < 2) {
        if (id === reqId.current) {
          setResults([]);
          setLoading(false);
        }
        return;
      }
      setLoading(true);
      void (async () => {
        try {
          const { users } = await api.users.lookup(q);
          if (id === reqId.current) setResults(users);
        } catch {
          if (id === reqId.current) setResults([]);
        } finally {
          if (id === reqId.current) setLoading(false);
        }
      })();
    }, 200);
    return () => clearTimeout(t);
  }, [value, open]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const shown = results.filter((u) => !exclude?.has(u.email.toLowerCase()));

  const pick = (email: string) => {
    onChange(email);
    setOpen(false);
    setActive(-1);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, shown.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && active >= 0 && shown[active]) {
      e.preventDefault();
      pick(shown[active].email);
    }
  };

  return (
    <div className="lookup" ref={rootRef}>
      <div className="lookup-field">
        <input
          type="email"
          className="lookup-input"
          placeholder={placeholder ?? 'search by email…'}
          value={value}
          disabled={disabled}
          autoComplete="off"
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        <svg className="lookup-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden>
          <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </div>
      {open && (
        <ul className="lookup-results" role="listbox">
          {shown.length === 0 ? (
            <li className="lookup-empty">{loading ? 'Searching…' : 'No results'}</li>
          ) : (
            shown.map((u, i) => (
              <li key={u.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  className={`lookup-row ${i === active ? 'active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(u.email)}
                >
                  {u.email}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
