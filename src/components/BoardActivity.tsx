// Board activity strip: a compact "seen by / edited by + time" row per member, shown
// next to the board. On open it pings the seen-beacon (marking the viewer present) then
// reads the board's presence. Best-effort: any failure just renders nothing. Backed by
// the board_activity presence table — see AUTH_IMPLEMENTATION_PLAN.md.

import { useEffect, useState } from 'react';
import { api, type BoardActivityRow } from '../api/client';
import { timeAgo } from '../util/dates';

function localPart(email: string): string {
  return email.split('@')[0];
}

export function BoardActivity({ tabId }: { tabId: string }) {
  const [rows, setRows] = useState<BoardActivityRow[]>([]);

  useEffect(() => {
    let alive = true;
    // Mark myself present, THEN read — so the viewer's own visit is reflected immediately.
    void api.activity
      .seen(tabId)
      .then(() => api.activity.get(tabId))
      .then((r) => {
        if (alive && r) setRows(r.activity);
      })
      .catch(() => {
        /* presence is best-effort */
      });
    return () => {
      alive = false;
    };
  }, [tabId]);

  if (!rows.length) return null;

  return (
    <div className="board-activity" aria-label="board activity">
      {rows.map((r) => {
        const edited = r.lastEditedAt;
        const seen = r.lastSeenAt;
        // Show whichever is more recent; ISO strings compare lexicographically.
        const showEdited = !!edited && (!seen || edited > seen);
        const stamp = showEdited ? edited : seen;
        if (!stamp) return null;
        return (
          <span key={r.userId} className="ba-chip" title={`${r.email} — last ${showEdited ? 'edited' : 'seen'} ${timeAgo(stamp)}`}>
            <span className="ba-name">{localPart(r.email)}</span>
            <span className="ba-when">{showEdited ? 'edited' : 'seen'} {timeAgo(stamp)}</span>
          </span>
        );
      })}
    </div>
  );
}
