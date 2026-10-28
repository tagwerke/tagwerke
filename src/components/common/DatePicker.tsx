// The date picker: a trigger that reads as the date it holds, and a month grid under it.
//
// It replaces the browser's <input type="date">, which draws a different control on every
// platform, shows "yyyy-mm-dd" when empty, and could not be made to sit quietly in the task page's
// property rail. Built on the Dropdown's own classes (`dd`, `dd-trigger`, `dd-panel`) so it lands
// wherever a Dropdown is already styled — the rail, a form — without a parallel look.
//
// Weeks start on Monday, as the calendar's do. The quick picks are the action menu's (Today,
// Tomorrow, Next week), so "next week" means the same day everywhere.
//
// Keyboard: the grid is one tab stop. Arrows move a day / a week, PageUp/PageDown a month,
// Home/End the week's ends, Enter picks, Escape closes and hands focus back to the trigger.

import { useEffect, useRef, useState } from 'react';
import { formatDateLabel, toISO, todayISO } from '../../util/dates';

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

const parse = (iso: string) => new Date(`${iso}T00:00:00`);
const addDays = (iso: string, n: number) => {
  const d = parse(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
};
const addMonths = (iso: string, n: number) => {
  const d = parse(iso);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  // Jan 31 + 1 month is the last day of February, not March 3.
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return toISO(d);
};
const monthKey = (iso: string) => iso.slice(0, 7);

/** The 42 days (six Monday-first weeks) that show the month containing `iso`. */
function monthGrid(iso: string): string[] {
  const first = parse(`${monthKey(iso)}-01`);
  const lead = (first.getDay() + 6) % 7; // Monday = 0
  first.setDate(first.getDate() - lead);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(first);
    d.setDate(first.getDate() + i);
    return toISO(d);
  });
}

export function DatePicker({ value, onChange, placeholder = 'No date', clearable = true, quickPicks = true, align = 'left', className, disabled, ariaLabel }: {
  /** An ISO date (YYYY-MM-DD), or empty for none. */
  value: string | undefined;
  /** Undefined = cleared. */
  onChange: (iso: string | undefined) => void;
  placeholder?: string;
  /** Offer "Clear". Off where a date is required (the calendar's day cursor). */
  clearable?: boolean;
  /** Offer Today / Tomorrow / Next week. */
  quickPicks?: boolean;
  /** Which edge of the trigger the panel lines up with. */
  align?: 'left' | 'right';
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  // The day the keyboard is on. Also decides which month is showing.
  const [cursor, setCursor] = useState(() => value || todayISO());
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  // Only move DOM focus into the grid when the keyboard is driving; a mouse click on a month
  // arrow should not yank focus onto a day.
  const keyboardNav = useRef(false);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (!open || !keyboardNav.current) return;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-iso="${cursor}"]`)?.focus();
  }, [open, cursor]);

  const today = todayISO();
  const daysToMonday = ((8 - parse(today).getDay()) % 7) || 7;
  const picks = [
    { label: 'Today', iso: today },
    { label: 'Tomorrow', iso: addDays(today, 1) },
    { label: 'Next week', iso: addDays(today, daysToMonday) },
  ];

  const openPanel = (viaKeyboard: boolean) => {
    setCursor(value || today);
    keyboardNav.current = viaKeyboard;
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };
  const pick = (iso: string | undefined) => {
    onChange(iso);
    close(true);
  };

  const onPickButton = (e: React.MouseEvent<HTMLButtonElement>) => pick(e.currentTarget.dataset.iso);

  const onGridKey = (e: React.KeyboardEvent) => {
    const step: Record<string, () => string> = {
      ArrowLeft: () => addDays(cursor, -1),
      ArrowRight: () => addDays(cursor, 1),
      ArrowUp: () => addDays(cursor, -7),
      ArrowDown: () => addDays(cursor, 7),
      PageUp: () => addMonths(cursor, -1),
      PageDown: () => addMonths(cursor, 1),
      Home: () => addDays(cursor, -((parse(cursor).getDay() + 6) % 7)),
      End: () => addDays(cursor, 6 - ((parse(cursor).getDay() + 6) % 7)),
    };
    if (step[e.key]) {
      e.preventDefault();
      keyboardNav.current = true;
      setCursor(step[e.key]());
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick(cursor);
    }
  };

  const days = monthGrid(cursor);
  const month = parse(`${monthKey(cursor)}-01`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  return (
    <div
      className={`dd dp ${open ? 'open' : ''} ${value ? '' : 'is-unset'} ${className ?? ''}`}
      ref={rootRef}
      onKeyDown={(e) => {
        // stopPropagation so Escape closes just the picker, not a parent modal or the page.
        if (open && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="dd-trigger"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel ? `${ariaLabel}: ${value ? formatDateLabel(value) : placeholder}` : undefined}
        onClick={() => (open ? close(false) : openPanel(false))}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openPanel(true); }
        }}
      >
        <span className="dd-trigger-value">
          <svg viewBox="0 0 16 16" width="13" height="13" className="dp-icon" aria-hidden>
            <rect x="2" y="3" width="12" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          {value ? formatDateLabel(value) : <span className="dd-trigger-placeholder">{placeholder}</span>}
        </span>
        <svg viewBox="0 0 12 12" width="10" height="10" className="dd-caret" aria-hidden>
          <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className={`dd-panel dp-panel ${align === 'right' ? 'is-right' : ''}`} role="dialog" aria-label="Choose a date">
          <div className="dp-head">
            <button type="button" className="icon-btn" aria-label="Previous month" onClick={() => setCursor(addMonths(cursor, -1))}>
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden><path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            <span className="dp-month" aria-live="polite">{month}</span>
            <button type="button" className="icon-btn" aria-label="Next month" onClick={() => setCursor(addMonths(cursor, 1))}>
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </div>

          <div className="dp-grid" role="grid" aria-label={month} ref={gridRef} onKeyDown={onGridKey}>
            {WEEKDAYS.map((w) => <span key={w} className="dp-weekday" role="columnheader">{w}</span>)}
            {days.map((iso) => {
              const outside = monthKey(iso) !== monthKey(cursor);
              return (
                <button
                  key={iso}
                  type="button"
                  data-iso={iso}
                  role="gridcell"
                  tabIndex={iso === cursor ? 0 : -1}
                  aria-selected={iso === value}
                  aria-label={parse(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
                  className={`dp-day ${outside ? 'is-outside' : ''} ${iso === today ? 'is-today' : ''} ${iso === value ? 'is-selected' : ''}`}
                  onClick={() => pick(iso)}
                >
                  {parse(iso).getDate()}
                </button>
              );
            })}
          </div>

          {(quickPicks || (clearable && value)) && (
            <div className="dp-foot">
              {quickPicks && picks.map((p) => (
                <button key={p.label} type="button" data-iso={p.iso} className={`dp-pick ${p.iso === value ? 'is-selected' : ''}`} onClick={onPickButton}>
                  {p.label}
                </button>
              ))}
              {clearable && value && (
                <button type="button" className="dp-pick dp-clear" onClick={() => pick(undefined)}>Clear</button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
