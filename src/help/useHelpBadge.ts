// Tracks whether the user has seen the newest HELP_UPDATES entry, so the "?" button can show a
// quiet "new" dot. localStorage only — no server round-trip, nothing to sync, nothing to break;
// worst case (storage blocked, e.g. private mode) is just an always-on or always-off dot.

import { useState } from 'react';
import { LATEST_HELP_UPDATE_ID } from './helpContent';

const KEY = 'tagwerke:help:lastSeenUpdateId';

function readLastSeen(): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
  } catch {
    return null;
  }
}

export function useHelpBadge(): { hasNew: boolean; markSeen: () => void } {
  const [lastSeen, setLastSeen] = useState<string | null>(readLastSeen);
  const markSeen = () => {
    if (!LATEST_HELP_UPDATE_ID || lastSeen === LATEST_HELP_UPDATE_ID) return;
    try {
      localStorage.setItem(KEY, LATEST_HELP_UPDATE_ID);
    } catch {
      /* storage blocked — badge just won't persist across reloads, not worth failing over */
    }
    setLastSeen(LATEST_HELP_UPDATE_ID);
  };
  return { hasNew: LATEST_HELP_UPDATE_ID !== null && lastSeen !== LATEST_HELP_UPDATE_ID, markSeen };
}
