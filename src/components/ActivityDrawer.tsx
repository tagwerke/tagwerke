// Per-object activity (Layer A of the accountability model, extended by COMMENTS_PLAN.md D3):
// who changed what on a single task or board — and, for a task, what people SAID about it, in the
// same timeline. Opened from a small affordance on the task row; progressive disclosure, nothing
// on the main surface.
//
// One interleaved list rather than two panes, because change-plus-discussion in one read is what
// makes comments worth having here: "moved to in_review" directly above "can you look at the
// second half?" is the whole story, and two tabs would hide half of it.
//
// The two halves have DIFFERENT permissions and that is deliberate: history is editor+ (enforced
// server-side), comments are viewer+ (D6). A viewer therefore gets the conversation and no change
// log, which is a legitimate state, not an error — the drawer says so quietly and moves on.
//
// This supersedes the old HistoryDrawer. `kind: 'tab'` is still history-only: boards have no
// comments, only their tasks do.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, type HistoryEntry } from '../api/client';
import { useStore } from '../store';
import { useSession } from '../session/useSession';
import { useComments } from '../comments/useComments';
import { CommentComposer } from './CommentComposer';
import { CommentItem } from './CommentItem';
import { describeRevert, revertTaskTo } from '../tasks/revertTask';
import { confirmRevertTask } from '../confirm/prompts';
import { formatTimestamp, timeAgo } from '../util/dates';
import { fieldLabel, USER_FIELDS } from '../util/audit';
import type { Comment } from '../types';

type Kind = 'task' | 'tab';

/** Humanize an audit action token into a short verb phrase. */
function actionVerb(action: string, payload: unknown): string {
  // A PUT is a create only when it carried a `created` marker; otherwise it's a replace/edit.
  if (action.startsWith('PUT')) return payload && typeof payload === 'object' && 'created' in payload ? 'created' : 'edited';
  if (action.startsWith('PATCH')) return 'edited';
  if (action.startsWith('DELETE')) return 'deleted';
  if (action === 'task_restore') return 'restored';
  if (action === 'task_approved') return 'approved';
  if (action === 'board_settings_change') return 'changed board settings';
  return action;
}

/**
 * Comment audit rows are dropped from the change log: the comment itself is already in this
 * timeline, so listing "commented" beside it would say the same thing twice — and the edit row
 * carries the previous text, which does not belong on a surface the whole board can read. The
 * rows still exist; they live in the admin audit log, where forensics belong.
 */
const COMMENT_ACTIONS = new Set(['comment_create', 'comment_edit', 'comment_delete']);

/** One row of the merged timeline. Both variants carry an ISO timestamp to sort on. */
type Item =
  | { kind: 'history'; at: string; entry: HistoryEntry; laterCount: number }
  | { kind: 'comment'; at: string; comment: Comment; replies: Comment[] };

export function ActivityDrawer({
  kind,
  id,
  boardId,
  title,
  onClose,
}: {
  kind: Kind;
  id: string;
  boardId: string;
  title: string;
  onClose: () => void;
}) {
  const members = useStore((s) => s.membersByBoard[boardId]);
  const myRole = useStore((s) => s.tabs[boardId]?.role);
  const meId = useSession((s) => s.user?.id);
  const comments = useComments((s) => (kind === 'task' ? s.byTask[id] : undefined));
  const commentsLoading = useComments((s) => (kind === 'task' ? s.loading[id] : false));
  const commentsError = useComments((s) => (kind === 'task' ? s.error[id] : null));
  const loadComments = useComments((s) => s.load);
  const post = useComments((s) => s.post);

  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A viewer is simply not allowed the change log. Distinct from `error`: nothing went wrong.
  const [historyDenied, setHistoryDenied] = useState(false);
  const [note, setNote] = useState<string | null>(null); // what the last restore actually did
  const [busy, setBusy] = useState<string | null>(null); // entry id being restored
  // On a task the drawer opens on the CONVERSATION, with the change log folded away behind a
  // line. Both were interleaved at first, and the result was that opening it to say something
  // landed you in a wall of "status todo → in_progress" with the composer below the fold. The
  // audit rows are still one click away, which is the right depth for them. A board has no
  // conversation, so there it stays open.
  const [showHistory, setShowHistory] = useState(kind === 'tab');

  // id → display name (email local-part), for resolving assignee/reviewer/approver values.
  const nameOf = useMemo(() => {
    const map = new Map((members ?? []).map((m) => [m.id, m.name]));
    return (uid: string) => map.get(uid) ?? uid;
  }, [members]);

  const load = useCallback(async () => {
    try {
      const res = kind === 'task' ? await api.history.task(id) : await api.history.tab(id);
      setEntries(res.entries);
      setHistoryDenied(false);
    } catch (e) {
      // 403 = editor+ only. On a task that still leaves a usable drawer (the conversation), so it
      // is reported as a missing section rather than a failure.
      if (e instanceof ApiError && e.status === 403 && kind === 'task') {
        setEntries([]);
        setHistoryDenied(true);
        return;
      }
      setError(e instanceof ApiError ? e.message.replace(/^.*-> \d+\s*/, '') : 'failed to load history');
    }
  }, [kind, id]);

  useEffect(() => {
    // The fetch resolves long after the effect; the rule can't see through the await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  useEffect(() => {
    if (kind === 'task') void loadComments(id);
  }, [kind, id, loadComments]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  /**
   * Restore the task to the state entry `e` left behind. `laterCount` is how many changes this
   * walks back — the confirm says so, because the row itself describes only its own change and the
   * reach is the part that would otherwise surprise.
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

  /**
   * The merged timeline, OLDEST FIRST — the reading order of a conversation, with the composer
   * under it where the next thing you write goes.
   *
   * `laterCount` is captured from the server's newest-first ordering before the sort, so the
   * restore reach stays correct no matter how the rows are eventually arranged: it is "how many
   * changes came after this one", not "how many rows are above it on screen".
   */
  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    if (showHistory) {
      (entries ?? []).forEach((entry, i) => {
        if (COMMENT_ACTIONS.has(entry.action)) return;
        out.push({ kind: 'history', at: entry.createdAt, entry, laterCount: i });
      });
    }
    if (comments) {
      const repliesOf = new Map<string, Comment[]>();
      for (const c of comments) {
        if (!c.parentCommentId) continue;
        const list = repliesOf.get(c.parentCommentId) ?? [];
        list.push(c);
        repliesOf.set(c.parentCommentId, list);
      }
      for (const c of comments) {
        // A reply travels with its parent, not as its own point on the timeline. One whose parent
        // is missing (deleted hard, or not yet loaded) is promoted to top level so it stays visible.
        if (c.parentCommentId && comments.some((p) => p.id === c.parentCommentId)) continue;
        out.push({ kind: 'comment', at: c.createdAt, comment: c, replies: repliesOf.get(c.id) ?? [] });
      }
    }
    return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }, [entries, comments, showHistory]);

  /** Change rows available to fold in — the count the toggle advertises. */
  const historyCount = (entries ?? []).filter((e) => !COMMENT_ACTIONS.has(e.action)).length;

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

  const isTask = kind === 'task';
  const loading = entries === null || (isTask && commentsLoading && !comments);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="share-panel history-panel" onClick={(e) => e.stopPropagation()}>
        <header className="share-head">
          <strong>{isTask ? 'Activity' : 'History'} — {title}</strong>
          <button className="icon-btn" onClick={onClose} aria-label="close">✕</button>
        </header>

        {error && <div className="share-error">{error}</div>}
        {commentsError && <div className="share-error">{commentsError}</div>}
        {note && <div className="history-note">{note}</div>}
        {historyDenied && <div className="history-note">Change history is available to editors of this board.</div>}

        <ul className="history-list">
          {items.map((item) =>
            item.kind === 'comment' ? (
              <CommentItem
                key={item.comment.id}
                comment={item.comment}
                replies={item.replies}
                tabId={boardId}
                taskId={id}
                meId={meId}
                canModerate={myRole === 'admin'}
              />
            ) : (
              <li key={item.entry.id} className="history-entry">
                <div className="history-line">
                  <span className="history-actor" title={item.entry.actorEmail ?? undefined}>
                    {item.entry.actorEmail?.split('@')[0] ?? item.entry.actorId ?? 'system'}
                  </span>
                  <span className="history-verb">{actionVerb(item.entry.action, item.entry.payload)}</span>
                  <span className="history-time" title={item.entry.createdAt}>{timeAgo(item.entry.createdAt)}</span>
                  {/* Every entry is a point this task can be put back to — except the newest,
                      which is where it already is. */}
                  {isTask && item.laterCount > 0 && (
                    <button
                      className="btn ghost tiny history-restore"
                      disabled={busy !== null}
                      onClick={() => void restoreTo(item.entry, item.laterCount)}
                      title={`Restore the task to how it was at ${formatTimestamp(item.entry.createdAt)}`}
                    >
                      {busy === item.entry.id ? '…' : 'Restore'}
                    </button>
                  )}
                </div>
                {details(item.entry.payload)}
              </li>
            ),
          )}
          {!loading && items.length === 0 && (
            <li className="share-empty">{isTask ? 'Nothing yet — say something below.' : 'No history yet.'}</li>
          )}
          {loading && !error && <li className="share-empty">Loading…</li>}
        </ul>

        {/* The fold. Placed under the timeline, not above it, so it reads as "there is more
            underneath this" rather than as a filter over what you are looking at. */}
        {isTask && !historyDenied && historyCount > 0 && (
          <button type="button" className="btn ghost tiny history-toggle" onClick={() => setShowHistory((v) => !v)}>
            {showHistory
              ? 'Hide change history'
              : `Show change history (${historyCount === 1 ? '1 change' : `${historyCount} changes`})`}
          </button>
        )}

        {isTask && (
          <CommentComposer tabId={boardId} onSubmit={(body) => void post(id, boardId, body)} />
        )}
      </div>
    </div>
  );
}
