// Per-object history (Layer A of the accountability model): a lightweight timeline of
// who changed what on a single task or board. Opened from a small "history" affordance —
// progressive disclosure, nothing on the main surface. Editor+ only (enforced server-side;
// the drawer simply shows an error if the caller lacks the role).

import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type HistoryEntry } from '../api/client';
import { useStore } from '../store';
import { timeAgo } from '../util/dates';
import { fieldLabel, USER_FIELDS } from '../util/audit';

type Kind = 'task' | 'tab';

/** Humanize an audit action token into a short verb phrase. */
function actionVerb(action: string): string {
  if (action.startsWith('PUT')) return 'created';
  if (action.startsWith('PATCH')) return 'edited';
  if (action.startsWith('DELETE')) return 'deleted';
  if (action === 'task_approved') return 'approved';
  if (action === 'board_settings_change') return 'changed board settings';
  return action;
}

export function HistoryDrawer({ kind, id, boardId, title, onClose }: { kind: Kind; id: string; boardId: string; title: string; onClose: () => void }) {
  const members = useStore((s) => s.membersByBoard[boardId]);
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // id → display name (email local-part), for resolving assignee/reviewer/approver values.
  const nameOf = useMemo(() => {
    const map = new Map((members ?? []).map((m) => [m.id, m.name]));
    return (uid: string) => map.get(uid) ?? uid;
  }, [members]);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = kind === 'task' ? await api.history.task(id) : await api.history.tab(id);
        if (live) setEntries(res.entries);
      } catch (e) {
        if (live) setError(e instanceof ApiError ? e.message.replace(/^.*-> \d+\s*/, '') : 'failed to load history');
      }
    })();
    return () => {
      live = false;
    };
  }, [kind, id]);

  function value(field: string, v: unknown): string {
    if (v == null || v === '') return '—';
    if (USER_FIELDS.has(field)) return nameOf(String(v));
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }

  /** Detail lines for one entry: field diffs, or a snapshot/created marker. */
  function details(payload: unknown): React.ReactNode {
    if (payload == null || typeof payload !== 'object') return null;
    const p = payload as Record<string, unknown>;
    if (Array.isArray(p.changes)) {
      return (
        <ul className="history-changes">
          {(p.changes as { field: string; from: unknown; to: unknown }[]).map((c, i) =>
            c.field === 'docJSON' ? (
              <li key={i}>edited the document</li>
            ) : (
              <li key={i}>
                <span className="history-field">{fieldLabel(c.field)}</span> {value(c.field, c.from)} <span className="history-arrow">→</span> {value(c.field, c.to)}
              </li>
            ),
          )}
        </ul>
      );
    }
    if (p.snapshot && typeof p.snapshot === 'object') {
      const s = p.snapshot as Record<string, unknown>;
      return <div className="history-detail">was “{String(s.text ?? s.name ?? '')}”</div>;
    }
    return null;
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="share-panel history-panel" onClick={(e) => e.stopPropagation()}>
        <header className="share-head">
          <strong>History — {title}</strong>
          <button className="icon-btn" onClick={onClose} aria-label="close">✕</button>
        </header>

        {error && <div className="share-error">{error}</div>}

        <ul className="history-list">
          {entries?.map((e) => (
            <li key={e.id} className="history-entry">
              <div className="history-line">
                <span className="history-actor" title={e.actorEmail ?? undefined}>{e.actorEmail?.split('@')[0] ?? e.actorId ?? 'system'}</span>
                <span className="history-verb">{actionVerb(e.action)}</span>
                <span className="history-time" title={e.createdAt}>{timeAgo(e.createdAt)}</span>
              </div>
              {details(e.payload)}
            </li>
          ))}
          {entries && entries.length === 0 && <li className="share-empty">No history yet.</li>}
          {!entries && !error && <li className="share-empty">Loading…</li>}
        </ul>
      </div>
    </div>
  );
}
