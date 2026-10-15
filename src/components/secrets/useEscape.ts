import { useEffect } from 'react';

/**
 * Close on Escape, in the CAPTURE phase, and claim the key. TabView's own window listener treats an
 * unclaimed Escape as "leave the board", and it was registered first, so a bubble-phase listener here
 * would run after it had already navigated away.
 */
export function useEscape(onEscape: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onEscape();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onEscape]);
}
