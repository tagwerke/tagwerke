// Per-object history (Layer A of the accountability model): a lightweight timeline of
// who changed what on a single task or board. Opened from a small "history" affordance —
// progressive disclosure, nothing on the main surface. Editor+ only (enforced server-side;
// the drawer simply shows an error if the caller lacks the role).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, type HistoryEntry } from '../api/client';
import { useStore } from '../store';
import { formatTimestamp, timeAgo } from '../util/dates';
import { fieldLabel, USER_FIELDS } from '../util/audit';
import { confirmRevertTask } from '../confirm/prompts';
import { describeRevert, revertTaskTo } from '../tasks/revertTask';

type Kind = 'task' | 'tab';

/** Humanize an audit action token into a short verb phrase. */
function actionVerb(action: string, payload: unknown): string {
  // A PUT is a create only when it carried a `created` marker; otherwise it's a replace/edit.
  if (action.startsWith('PUT')) return payload && typeof payload === 'object' && 'created' in payload ? 'created' : 'edited';
  if (action.startsWith('PATCH')) return 'edited';
  if (action.startsWith('DELETE')) return 'deleted';
  if (action === 'task_restore') return 'restored';
  if (action === 'task_revert') return 'rolled back';
  if (action === 'task_approved') return 'approved';
  if (action === 'board_settings_change') return 'changed board settings';
  return action;
}

export function HistoryDrawer({ kind, id, boardId, title, onClose }: { kind: Kind; id: string; boardId: string; title: string; onClose: () => void }) {
  const members = useStore((s) => s.membersByBoard[boardId]);
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null); // what the last restore actually did
  const [busy, setBusy] = useState<string | null>(null); // entry id being restored

  // id → display name (email local-part), for resolving assignee/reviewer/approver values.
  const nameOf = useMemo(() => {
    const map = new Map((members ?? []).map((m) => [m.id, m.name]));
    return (uid: string) => map.get(uid) ?? uid;
  }, [members]);

  const load = useCallback(async () => {
    try {
      const res = kind === 'task' ? await api.history.task(id) : await api.history.tab(id);
      setEntries(res.entries);
    } catch (e) {
      setError(e instanceof ApiError ? e.message.replace(/^.*-> \d+\s*/, '') : 'failed to load history');
    }
  }, [kind, id]);

  useEffect(() => {
    // The fetch resolves long after the effect; the rule can't see through the await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  /**
   * Restore the task to the state entry `e` left behind. The count of entries above it is the
   * number of changes this walks back — the confirm says so, because the row itself describes only
   * its own change and the reach is the part that would otherwise surprise.
   */
  async function restoreTo(e: HistoryEntry, laterCount: number) {
    if (!(await confirmRevertTask(formatTimestamp(e.createdAt), laterCount))) return;
    setBusy(e.id);
    setError(null);
    setNote(null);
    try {
      setNote(describeRevert(await revertTaskTo(id, e.id)));
      await load(); // the restore is itself an entry — show it
    } catch (err) {
      setError(err instanceof ApiError ? err.message.replace(/^.*-> \d+\s*/, '') : 'restore failed');
    } finally {
      setBusy(null);
    }
  }

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
    // A rollback's own row: the fields it put back, plus the ones today's board refused. The
    // refusals belong in the trail as much as the changes — they are why the task doesn't match
    // the point it was restored to.
    const skipped = Array.isArray(p.skipped) ? (p.skipped as { field: string; reason: string }[]) : null;
    if (Array.isArray(p.changes)) {
      return (
        <>
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
        {skipped?.map((s, i) => (
          <div key={i} className="history-detail">couldn’t restore {fieldLabel(s.field)} — {s.reason}</div>
        ))}
        </>
      );
    }
    if (p.snapshot && typeof p.snapshot === 'object') {
      const s = p.snapshot as Record<string, unknown>;
      return <div className="history-detail">was “{String(s.text ?? s.name ?? '')}”</div>;
    }
    if (p.created && typeof p.created === 'object') {
      const c = p.created as Record<string, unknown>;
      return c.text ? <div className="history-detail">as “{String(c.text)}”</div> : null;
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
        {note && <div className="history-note">{note}</div>}

        <ul className="history-list">
          {entries?.map((e, i) => (
            <li key={e.id} className="history-entry">
              <div className="history-line">
                <span className="history-actor" title={e.actorEmail ?? undefined}>{e.actorEmail?.split('@')[0] ?? e.actorId ?? 'system'}</span>
                <span className="history-verb">{actionVerb(e.action, e.payload)}</span>
                <span className="history-time" title={e.createdAt}>{timeAgo(e.createdAt)}</span>
                {/* Every entry is a point this task can be put back to — except the newest, which
                    is where it already is. `i` doubles as the number of changes it walks back. */}
                {kind === 'task' && i > 0 && (
                  <button
                    className="btn ghost tiny history-restore"
                    disabled={busy !== null}
                    onClick={() => void restoreTo(e, i)}
                    title={`Restore the task to how it was at ${formatTimestamp(e.createdAt)}`}
                  >
                    {busy === e.id ? '…' : 'Restore'}
                  </button>
                )}
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
