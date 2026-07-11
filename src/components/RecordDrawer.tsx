// Right-hand drawer that previews the actual record behind an audit id (the target, actor, or
// scope). Shows the current state + a change list (both from an admin-gated, cross-board endpoint),
// so the admin can see "what is this task / who is this person / what is this board" without
// leaving the log. Non-blocking: clicking another value swaps the drawer's contents.

import { useEffect, useState } from 'react';
import { api, ApiError, type HistoryEntry, type PreviewRecord } from '../api/client';
import { formatTimestamp, timeAgo } from '../util/dates';

export interface PreviewTarget {
  type: string; // task | tab | user | board_member
  id: string;
  scope?: string; // board id, for a board_member
  fallbackLabel?: string; // shown in the tombstone when the record is gone
}

const TYPE_LABEL: Record<string, string> = { task: 'Task', tab: 'Board', user: 'User', board_member: 'Member' };
const isIso = (v: string) => /^\d{4}-\d{2}-\d{2}T/.test(v);

export function RecordDrawer({ target, onClose }: { target: PreviewTarget; onClose: () => void }) {
  const [record, setRecord] = useState<PreviewRecord | null | undefined>(undefined); // undefined = loading
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The parent keys this component by target, so a new target remounts with fresh state — no
  // synchronous reset needed here; the effect just fetches.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await api.admin.record(target.type, target.id, target.scope);
        if (!live) return;
        setRecord(res.record);
        setHistory(res.history);
      } catch (e) {
        if (!live) return;
        setRecord(null);
        setError(e instanceof ApiError ? e.message.replace(/^.*-> \d+\s*/, '') : 'failed to load');
      }
    })();
    return () => {
      live = false;
    };
  }, [target.type, target.id, target.scope]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="record-drawer-backdrop" onClick={onClose} />
      <aside className="record-drawer" role="dialog" aria-label="record preview">
        <header className="record-drawer-head">
          <span className="record-type">{TYPE_LABEL[target.type] ?? target.type}</span>
          <button className="icon-btn" onClick={onClose} aria-label="close">✕</button>
        </header>

        {record === undefined ? (
          <div className="share-empty">Loading…</div>
        ) : record === null ? (
          <div className="record-tombstone">
            <strong>{target.fallbackLabel || `${target.type}:${target.id}`}</strong>
            <p>This record no longer exists — it was deleted or purged.</p>
            {error && <div className="share-error">{error}</div>}
          </div>
        ) : (
          <>
            <h3 className="record-title">
              {record.title}
              {record.deleted && <span className="record-deleted">deleted</span>}
            </h3>
            <dl className="record-fields">
              {record.fields.map((f) => (
                <div key={f.label} className="record-field">
                  <dt>{f.label}</dt>
                  <dd>{isIso(f.value) ? formatTimestamp(f.value) : f.value}</dd>
                </div>
              ))}
            </dl>
          </>
        )}

        <div className="record-history">
          <div className="record-history-head">Changes</div>
          <ul className="record-history-list">
            {history?.map((h) => (
              <li key={h.id} className="record-history-entry">
                <span className="record-history-actor" title={h.actorEmail ?? undefined}>
                  {h.actorEmail?.split('@')[0] ?? h.actorId ?? 'system'}
                </span>
                <span className="record-history-action">{h.action}</span>
                <span className="record-history-time" title={h.createdAt}>{timeAgo(h.createdAt)}</span>
              </li>
            ))}
            {history && history.length === 0 && <li className="share-empty">No changes recorded.</li>}
            {!history && record !== undefined && <li className="share-empty">—</li>}
          </ul>
        </div>
      </aside>
    </>
  );
}
