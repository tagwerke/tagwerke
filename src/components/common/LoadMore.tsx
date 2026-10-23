import { useEffect, useRef } from 'react';

// The end of a paged list: one control, so every long list (history, notifications, Trash, the admin
// audit log) says "there is more" the same way. At the bottom of a newest-first list it also loads on
// its own as it scrolls into view — reaching the end of the list is the request. The button stays as
// the fallback when the observer can't fire (the page didn't fill the scroller) and for the keyboard.
//
// `auto={false}` for a list read oldest-first, where this sits at the TOP: there it is visible the
// moment the list opens, and loading on sight would pull every page in one go.

export function LoadMore({
  hasMore,
  busy,
  onLoad,
  label = 'Show older',
  endLabel,
  auto = true,
}: {
  hasMore: boolean;
  busy: boolean;
  onLoad: () => void;
  label?: string;
  /** Said quietly once the last page is in. Omitted = say nothing. */
  endLabel?: string;
  auto?: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  // The observer is set up once per mount; it reads the latest props through these.
  const latest = useRef({ busy, onLoad });
  useEffect(() => {
    latest.current = { busy, onLoad };
  });

  useEffect(() => {
    const el = ref.current;
    if (!auto || !hasMore || !el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((seen) => {
      if (seen.some((e) => e.isIntersecting) && !latest.current.busy) latest.current.onLoad();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [auto, hasMore]);

  if (!hasMore) return endLabel ? <div className="load-more is-end">{endLabel}</div> : null;
  return (
    <div className="load-more">
      <button ref={ref} type="button" className="load-more-btn" disabled={busy} onClick={onLoad}>
        {busy ? 'Loading…' : label}
      </button>
    </div>
  );
}
