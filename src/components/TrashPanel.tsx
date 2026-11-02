// Trash (recoverability, §G): a board's soft-deleted tasks, each restorable — board settings ›
// Trash. Editor+ (enforced server-side). Restoring reloads authoritative state so the task
// reappears with its metadata intact. Auto-purged after the retention window by the prune job.

import { useEffect, useState } from 'react';
import { api, ApiError, type TrashedTask } from '../api/client';
import { useStore } from '../store';
import { timeAgo } from '../util/dates';
import { Notice } from './common/Notice';
import { EmptyState, Loading } from './common/EmptyState';
import { LoadMore } from './common/LoadMore';
import { askConfirm } from '../confirm/useConfirm';
import { showToast } from '../toast/useToast';

export function TrashPanel({ tabId }: { tabId: string }) {
  const members = useStore((s) => s.membersByBoard[tabId]);
  const isAdmin = useStore((s) => s.tabs[tabId]?.role === 'admin');
  const [tasks, setTasks] = useState<TrashedTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Best label for a trashed task: live text → retained last title → untitled placeholder.
  const label = (t: TrashedTask) => (t.text.trim() ? t.text : t.lastTitle?.trim() ? t.lastTitle : '(untitled)');
  const assigneeName = (id: string | null) => (id ? members?.find((m) => m.id === id)?.name : undefined);

  async function refresh() {
    try {
      const page = await api.trash.list(tabId);
      setTasks(page.tasks);
      setCursor(page.nextCursor);
    } catch (e) {
      setError(e instanceof ApiError ? e.message.replace(/^.*-> \d+\s*/, '') : 'failed to load trash');
    }
  }

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.trash.list(tabId, cursor);
      setTasks((prev) => [...(prev ?? []), ...page.tasks]);
      setCursor(page.nextCursor);
    } catch (e) {
      setError(e instanceof ApiError ? e.message.replace(/^.*-> \d+\s*/, '') : 'failed to load trash');
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [tabId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Delete forever (CUSTOM_FIELDS_PLAN P5): board admins only, and the one thing in the app that
  // can't be undone, so it asks first and says so.
  async function purge(t: TrashedTask) {
    const ok = await askConfirm({
      title: `Delete “${label(t)}” forever?`,
      body: 'The task, its sub-tasks in the Trash and their comments are erased. History keeps that it happened and which fields changed, not what they said. This can’t be undone.',
      confirmLabel: 'Delete forever',
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.trash.purge(t.id);
      setTasks((prev) => prev?.filter((x) => !r.deleted.includes(x.id)) ?? prev);
      if (r.documents.length) {
        const names = r.documents.map((d) => d.name).join(', ');
        showToast(`Deleted forever. ${r.documents.length === 1 ? 'Its file stays' : 'Its files stay'} on the board's Files: ${names}`);
      } else showToast('Deleted forever.');
    } catch (e) {
      setError(e instanceof ApiError ? e.message.replace(/^.*-> \d+\s*/, '') : 'delete failed');
    } finally {
      setBusy(false);
    }
  }

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
    <>
      {error && <Notice>{error}</Notice>}

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
            <button className="row-action" disabled={busy} onClick={() => restore(t.id)}>Restore</button>
            {isAdmin && <button className="row-action danger" disabled={busy} onClick={() => void purge(t)}>Delete forever</button>}
          </li>
        ))}
        {tasks && tasks.length === 0 && <EmptyState as="li">Trash is empty.</EmptyState>}
        {!tasks && !error && <Loading as="li" />}
        {tasks && tasks.length > 0 && (
          <li><LoadMore hasMore={!!cursor} busy={loadingMore} onLoad={() => void loadMore()} /></li>
        )}
      </ul>
    </>
  );
}
