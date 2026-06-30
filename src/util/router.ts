// Minimal path routing — no router dependency. The app is otherwise panel/state driven;
// this only exists so /admin can be its own page reachable by typing the URL.

import { useEffect, useState } from 'react';

/** Navigate to a path and notify usePath() listeners. */
export function navigate(to: string): void {
  if (to === window.location.pathname) return;
  window.history.pushState(null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
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
