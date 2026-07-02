// Trash view (recoverability, §G): a board's soft-deleted tasks, each restorable. Editor+
// (enforced server-side). Restoring reloads authoritative state so the task reappears with
// its metadata intact. Auto-purged after the retention window by the prune job.

import { useEffect, useState } from 'react';
import { api, ApiError, type TrashedTask } from '../api/client';
import { useStore } from '../store';
import { timeAgo } from '../util/dates';

export function TrashPanel({ tabId, tabName, onClose }: { tabId: string; tabName: string; onClose: () => void }) {
  const members = useStore((s) => s.membersByBoard[tabId]);
  const [tasks, setTasks] = useState<TrashedTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Best label for a trashed task: live text → retained last title → untitled placeholder.
  const label = (t: TrashedTask) => (t.text.trim() ? t.text : t.lastTitle?.trim() ? t.lastTitle : '(untitled)');
  const assigneeName = (id: string | null) => (id ? members?.find((m) => m.id === id)?.name : undefined);

  async function refresh() {
    try {
      const { tasks } = await api.trash.list(tabId);
      setTasks(tasks);
    } catch (e) {
      setError(e instanceof ApiError ? e.message.replace(/^.*-> \d+\s*/, '') : 'failed to load trash');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [tabId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function restore(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api.trash.restore(id);
      // Reload authoritative state so the restored task returns with full metadata.
      window.location.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message.replace(/^.*-> \d+\s*/, '') : 'restore failed');
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="share-panel" onClick={(e) => e.stopPropagation()}>
        <header className="share-head">
          <strong>Trash — {tabName}</strong>
          <button className="icon-btn" onClick={onClose} aria-label="close">✕</button>
        </header>

        {error && <div className="share-error">{error}</div>}

        <ul className="trash-list">
          {tasks?.map((t) => (
            <li key={t.id} className="trash-item">
              <div className="trash-main">
                <span className={`trash-text ${label(t) === '(untitled)' ? 'is-untitled' : ''}`}>{label(t)}</span>
                <span className="trash-meta">
                  {assigneeName(t.assigneeId) ? `assigned to ${assigneeName(t.assigneeId)} · ` : ''}
                  deleted by {t.deleterEmail?.split('@')[0] ?? t.deletedBy ?? 'system'}
                  {t.deletedAt ? ` · ${timeAgo(t.deletedAt)}` : ''}
                </span>
              </div>
              <button className="btn ghost tiny" disabled={busy} onClick={() => restore(t.id)}>Restore</button>
            </li>
          ))}
          {tasks && tasks.length === 0 && <li className="share-empty">Trash is empty.</li>}
          {!tasks && !error && <li className="share-empty">Loading…</li>}
        </ul>
      </div>
    </div>
  );
}
