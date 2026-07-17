// Minimal path routing — no router dependency. The app is otherwise panel/state driven;
// this only exists so /admin can be its own page reachable by typing the URL.

import { useEffect, useState } from 'react';

/** Navigate to a path and notify usePath() listeners. */
export function navigate(to: string): void {
  if (to === window.location.pathname) return;
  window.history.pushState(null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** The calendar route. */
export const CALENDAR_PATH = '/calendar';
export function isCalendarPath(path: string): boolean {
  return path === CALENDAR_PATH;
}

/** The URL path for a given open board (or the grid when null). */
export function boardPath(tabId: string | null): string {
  return tabId ? `/b/${encodeURIComponent(tabId)}` : '/';
}

/** Parse the open-board id out of a path, or null for the grid. */
export function parseBoardId(path: string): string | null {
  const m = path.match(/^\/b\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Current pathname, updated on back/forward and navigate(). */
export function usePath(): string {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return path;
}
