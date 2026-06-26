// Compact calendar popover. No date library — builds a month grid by hand.
// onPick(undefined) clears the date. Closes on outside click / Escape.

import { useEffect, useMemo, useRef, useState } from 'react';
import { toISO, todayISO } from '../util/dates';

interface Props {
  value?: string; // ISO yyyy-mm-dd
  onPick: (iso: string | undefined) => void;
  onClose: () => void;
}

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function DatePicker({ value, onPick, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  const initial = value ? new Date(value + 'T00:00:00') : new Date();
  const [view, setView] = useState({ y: initial.getFullYear(), m: initial.getMonth() });

  const today = todayISO();
  const cells = useMemo(() => {
    const first = new Date(view.y, view.m, 1);
    const startDow = first.getDay();
    const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
    const out: (string | null)[] = [];
    for (let i = 0; i < startDow; i++) out.push(null);
    for (let d = 1; d <= daysInMonth; d++) out.push(toISO(new Date(view.y, view.m, d)));
    return out;
  }, [view]);

  const step = (delta: number) => {
    const m = view.m + delta;
    setView({ y: view.y + Math.floor(m / 12), m: ((m % 12) + 12) % 12 });
  };

  const quick = (iso: string) => onPick(iso);

  return (
    <div className="date-picker" ref={ref} contentEditable={false}>
      <div className="date-picker-head">
        <button type="button" className="dp-nav" onClick={() => step(-1)} aria-label="Previous month">‹</button>
        <span className="dp-title">{MONTHS[view.m]} {view.y}</span>
        <button type="button" className="dp-nav" onClick={() => step(1)} aria-label="Next month">›</button>
      </div>
      <div className="date-picker-grid">
        {WEEKDAYS.map((w, i) => <span key={`w${i}`} className="dp-dow">{w}</span>)}
        {cells.map((iso, i) =>
          iso == null ? (
            <span key={`e${i}`} className="dp-cell empty" />
          ) : (
            <button
              key={iso}
              type="button"
              className={`dp-cell ${iso === value ? 'selected' : ''} ${iso === today ? 'today' : ''}`}
              onClick={() => onPick(iso)}
            >
              {Number(iso.slice(8, 10))}
            </button>
          ),
        )}
      </div>
      <div className="date-picker-foot">
        <button type="button" className="dp-quick" onClick={() => quick(today)}>Today</button>
        <button type="button" className="dp-quick" onClick={() => {
          const d = new Date(); d.setDate(d.getDate() + 1); quick(toISO(d));
        }}>Tomorrow</button>
        {value && <button type="button" className="dp-quick clear" onClick={() => onPick(undefined)}>Clear</button>}
      </div>
    </div>
  );
}
