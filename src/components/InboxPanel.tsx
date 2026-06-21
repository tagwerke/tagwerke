// Email→task confirm queue. Lists pending drafts (Haiku read a forwarded email
// and judged it actionable); the user keeps each into a board (creating a real
// task via the normal doc path) or dismisses it. One-glance triage.

import { useEffect, useState } from 'react';
import { api, ApiError, type InboundDraft } from '../api/client';
import { useStore } from '../store';
import type { Tab } from '../types';

export function InboxPanel({ onClose, onChanged }: { onClose: () => void; onChanged?: () => void }) {
  const boards = useStore((s) =>
    s.tabOrder.map((id) => s.tabs[id]).filter((t): t is Tab => !!t && t.type === 'normal'),
  );
  const appendTaskFromDraft = useStore((s) => s.appendTaskFromDraft);

  const [drafts, setDrafts] = useState<InboundDraft[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<Record<string, string>>({}); // draftId -> tabId

  const defaultBoard = boards[0]?.id ?? '';

  async function refresh() {
    try {
      const { drafts } = await api.inbox.list();
      setDrafts(drafts);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'failed to load inbox');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, []);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
      onChanged?.();
    } catch (e) {
      setError(e instanceof ApiError ? e.message.replace(/^.*-> \d+\s*/, '') : 'action failed');
    } finally {
      setBusy(false);
    }
  }

  function keep(d: InboundDraft) {
    const tabId = target[d.id] ?? defaultBoard;
    if (!tabId) {
      setError('Create a board first to keep tasks into.');
      return;
    }
    void run(async () => {
      const taskId = appendTaskFromDraft(tabId, { text: d.title, date: d.suggestedDate, owner: d.suggestedOwner });
      await api.inbox.keep(d.id, { keptTaskId: taskId });
    });
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="share-panel inbox-panel" onClick={(e) => e.stopPropagation()}>
        <header className="share-head">
          <strong>Inbox · email tasks to review</strong>
          <button className="icon-btn" onClick={onClose} aria-label="close">✕</button>
        </header>

        {error && <div className="share-error">{error}</div>}

        <div className="inbox-list">
          {drafts?.length === 0 && (
            <div className="share-empty">Nothing to review. Forwarded emails that look actionable land here.</div>
          )}
          {drafts?.map((d) => (
            <div key={d.id} className="inbox-card">
              <div className="inbox-title">{d.title}</div>
              {d.summary && <div className="inbox-summary">{d.summary}</div>}
              <div className="inbox-meta">
                {d.fromAddr && <span title={d.fromAddr}>from {d.fromAddr}</span>}
                {d.suggestedDate && <span>· due {d.suggestedDate}</span>}
                {d.suggestedOwner && <span>· {d.suggestedOwner}</span>}
                {typeof d.confidence === 'number' && <span>· {d.confidence}%</span>}
                {d.extractionFailed && <span className="inbox-warn">· auto-read failed</span>}
              </div>
              <div className="inbox-actions">
                <select
                  value={target[d.id] ?? defaultBoard}
                  onChange={(e) => setTarget((t) => ({ ...t, [d.id]: e.target.value }))}
                  disabled={busy || !boards.length}
                >
                  {boards.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
                <button className="btn primary" disabled={busy || !boards.length} onClick={() => keep(d)}>Keep</button>
                <button className="btn ghost" disabled={busy} onClick={() => void run(() => api.inbox.dismiss(d.id))}>
                  Dismiss
                </button>
              </div>
            </div>
          ))}
          {!drafts && <div className="share-empty">Loading…</div>}
        </div>
      </div>
    </div>
  );
}
