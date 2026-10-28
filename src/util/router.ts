// Minimal path routing — no router dependency. The app is otherwise panel/state driven;
// this only exists so /admin can be its own page reachable by typing the URL.

import { useEffect, useState } from 'react';
import { BOARD_SETTINGS_SECTIONS, type BoardSettingsSection } from '../types';

/** Navigate to a path and notify usePath() listeners. */
export function navigate(to: string): void {
  if (to === window.location.pathname + window.location.search) return;
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

/** Parse the open-board id out of a path, or null for the grid. Matches `/b/:id` and any
 *  sub-path of it (`/b/:id/task/:taskId`, etc.) — only the first segment is a board id. */
export function parseBoardId(path: string): string | null {
  const m = path.match(/^\/b\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** A section of a board's settings — a real route, so a link (or a refresh) lands on it, unlike the
 *  board's views, which stay pure client state. */
export function boardSettingsPath(tabId: string, section: BoardSettingsSection): string {
  return `/b/${encodeURIComponent(tabId)}/settings/${section}`;
}

/** The settings section a path names, or null. `/b/:id/settings` alone is General, an unknown
 *  section falls back to it too, and the old `/b/:id/sprints` (the sprints page, before it moved
 *  into settings) still lands on Sprints. */
export function parseBoardSettings(path: string): BoardSettingsSection | null {
  if (/^\/b\/[^/]+\/sprints\/?$/.test(path)) return 'sprints';
  const m = path.match(/^\/b\/[^/]+\/settings(?:\/([^/]+))?\/?$/);
  if (!m) return null;
  const section = m[1] as BoardSettingsSection | undefined;
  return section && BOARD_SETTINGS_SECTIONS.includes(section) ? section : 'general';
}

/** The URL for a task's own page. Pushed as a NEW history entry (see navigate()'s caller in
 *  the store's setOpenTask usage), so back returns to wherever the board was showing. */
export function boardTaskPath(tabId: string, taskId: string): string {
  return `/b/${encodeURIComponent(tabId)}/task/${encodeURIComponent(taskId)}`;
}

/** Parse the open task id out of a path, or null when the path isn't a task page. */
export function parseOpenTaskId(path: string): string | null {
  const m = path.match(/^\/b\/[^/]+\/task\/([^/]+)/);
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
