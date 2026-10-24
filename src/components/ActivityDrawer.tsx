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
import { ViaBadge } from './ViaBadge';
import { patNameOf } from '../util/via';
import { CommentComposer } from './CommentComposer';
import { CommentItem } from './CommentItem';
import { describeRevert, revertTaskTo } from '../tasks/revertTask';
import { confirmRevertTask } from '../confirm/prompts';
import { clockTime, dayHeading, formatTimestamp, timeAgo } from '../util/dates';
import { fieldLabel, statusLabelAt, USER_FIELDS } from '../util/audit';
import type { Comment } from '../types';
import { Notice } from './common/Notice';
import { EmptyState, Loading } from './common/EmptyState';
import { LoadMore } from './common/LoadMore';

type Kind = 'task' | 'tab';

/** Humanize an audit action token into a short verb phrase. */
function actionVerb(action: string, payload: unknown): string {
  // A PUT is a create only when it carried a `created` marker; otherwise it's a replace/edit.
  if (action.startsWith('PUT')) return payload && typeof payload === 'object' && 'created' in payload ? 'created' : 'edited';
  if (action.startsWith('PATCH')) return 'edited';
  if (action.startsWith('DELETE')) return 'deleted';
  if (action === 'task_restore') return 'restored';
  if (action === 'task_approved') return 'approved';
  if (action === 'task_revert') return 'rolled back';
  if (action === 'task_move') return 'moved';
  if (action === 'sprint_rollover') return 'carried over to the new week';
  if (action === 'board_settings_change') return 'changed board settings';
  if (action === 'agent_token_created') return 'created a board token';
  if (action === 'bulk_task_import') return 'imported tasks';
  if (action === 'board_state_change') {
    const p = (payload ?? {}) as { op?: string; state?: string };
    const name = p.state ? ` “${p.state}”` : '';
    if (p.op === 'create') return `added the task state${name}`;
    if (p.op === 'delete') return `deleted the task state${name}`;
    if (p.op === 'reorder') return 'reordered the task states';
    return `changed a task state${name}`;
  }
  // Any other route-shaped token ("POST /api/tabs/:id/…") is plumbing, not a sentence.
  if (/^[A-Z]+ \//.test(action)) return 'made a change';
  return action.replace(/_/g, ' ');
}

/**
 * Comment audit rows are dropped from the change log: the comment itself is already in this
 * timeline, so listing "commented" beside it would say the same thing twice — and the edit row
 * carries the previous text, which does not belong on a surface the whole board can read. The
 * rows still exist; they live in the admin audit log, where forensics belong.
 */
const COMMENT_ACTIONS = new Set(['comment_create', 'comment_edit', 'comment_delete']);

function hasChanges(payload: unknown): boolean {
  return !!payload && typeof payload === 'object' && Array.isArray((payload as { changes?: unknown }).changes);
}

/** One row of the merged timeline. Both variants carry an ISO timestamp to sort on. */
type Item =
  | { kind: 'history'; at: string; entry: HistoryEntry; laterCount: number }
  | { kind: 'comment'; at: string; comment: Comment; replies: Comment[] };

/** "parent → Accounts", or "status todo → done" — the before side is dropped when there wasn't one. */
function Change({ label, from, to }: { label: string; from: string; to: string }) {
  return (
    <>
      <span className="history-field">{label}</span>{' '}
      {from !== '—' && <>{from} <span className="history-arrow">→</span> </>}
      {from === '—' && <span className="history-arrow">→ </span>}
      <span className="history-to">{to === '—' ? 'none' : to}</span>
    </>
  );
}

export function ActivityDrawer({
  kind,
  id,
  boardId,
  title,
  onClose,
  embedded = false,
}: {
  kind: Kind;
  id: string;
  boardId: string;
  title: string;
  onClose: () => void;
  /** Render as a plain panel in the caller's own layout (the task page), instead of the
   *  modal-backdrop overlay this was originally built for. Same data, same actions — only the
   *  chrome around it changes. */
  embedded?: boolean;
}) {
  const members = useStore((s) => s.membersByBoard[boardId]);
  // For naming what a row points at: a move's boards, a sprint, a parent task.
  const tabs = useStore((s) => s.tabs);
  const sprints = useStore((s) => s.sprintsByBoard[boardId]);
  const allTasks = useStore((s) => s.tasks);
  const meId = useSession((s) => s.user?.id);
  const comments = useComments((s) => (kind === 'task' ? s.byTask[id] : undefined));
  const commentsLoading = useComments((s) => (kind === 'task' ? s.loading[id] : false));
  const commentsError = useComments((s) => (kind === 'task' ? s.error[id] : null));
  const loadComments = useComments((s) => s.load);
  const post = useComments((s) => s.post);

  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  // Where the next (older) page of the change log starts; null once it is all in.
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
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

  const fetchPage = useCallback(
    (after?: string | null) => (kind === 'task' ? api.history.task(id, after) : api.history.tab(id, after)),
    [kind, id],
  );

  const load = useCallback(async () => {
    try {
      const res = await fetchPage();
      setEntries(res.entries);
      setCursor(res.nextCursor);
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
  }, [kind, fetchPage]);

  /** Append the next older page. Older rows go on the END of `entries`, which is what keeps each
   *  row's `laterCount` (its index) true across pages. */
  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetchPage(cursor);
      setEntries((prev) => [...(prev ?? []), ...res.entries]);
      setCursor(res.nextCursor);
    } catch (e) {
      setError(e instanceof ApiError ? e.message.replace(/^.*-> \d+\s*/, '') : 'failed to load history');
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    // The fetch resolves long after the effect; the rule can't see through the await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  useEffect(() => {
    if (kind === 'task') void loadComments(id);
  }, [kind, id, loadComments]);

  // A notification link carries `?comment=<id>`. Once the thread is on screen, scroll to that comment
  // and flash it, then drop the query so a refresh doesn't repeat it. `search` follows navigation so a
  // second link to this same task (another comment) works without remounting.
  const [search, setSearch] = useState(() => window.location.search);
  useEffect(() => {
    const onNav = () => setSearch(window.location.search);
    window.addEventListener('popstate', onNav);
    return () => window.removeEventListener('popstate', onNav);
  }, []);
  useEffect(() => {
    if (kind !== 'task' || !comments) return;
    const want = new URLSearchParams(search).get('comment');
    if (!want) return;
    window.history.replaceState(null, '', window.location.pathname);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSearch('');
    const el = document.getElementById(`comment-${want}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('comment-flash');
    window.setTimeout(() => el.classList.remove('comment-flash'), 2200);
  }, [kind, comments, search]);

  useEffect(() => {
    if (embedded) return; // the task page owns its own Escape behavior
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [embedded, onClose]);

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
   * The merged timeline. On a task, OLDEST FIRST — the reading order of a conversation, with the
   * composer under it where the next thing you write goes. On a board, NEWEST FIRST: there is no
   * conversation, and what you open a board's history for is what just happened. (It was oldest-first
   * here too once, which put the latest change at the bottom of a scroll nobody reached.)
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
    const dir = kind === 'task' ? 1 : -1;
    return out.sort((a, b) => (a.at < b.at ? -dir : a.at > b.at ? dir : 0));
  }, [kind, entries, comments, showHistory]);

  /** Change rows available to fold in — the count the toggle advertises ("50+" while more pages wait). */
  const historyCount = (entries ?? []).filter((e) => !COMMENT_ACTIONS.has(e.action)).length;
  const historyCountLabel = `${historyCount}${cursor ? '+' : ''} ${historyCount === 1 && !cursor ? 'change' : 'changes'}`;

  function value(field: string, v: unknown): string {
    if (v == null || v === '') return '—';
    if (USER_FIELDS.has(field)) return nameOf(String(v));
    if (field === 'sprintId') return sprints?.find((sp) => sp.id === v)?.label ?? 'a deleted sprint';
    if (field === 'parentTaskId') return allTasks[String(v)]?.text || 'another task';
    if (Array.isArray(v)) return v.join(', ');
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
          {(p.changes as { field: string; from: unknown; to: unknown; fromLabel?: string; toLabel?: string }[]).map((c, i) => {
            if (c.field === 'docJSON') return <li key={i}>edited the document</li>;
            // A status shows the name it had at the time, not today's (D10).
            const from = c.field === 'status' ? statusLabelAt(c, 'from') ?? '—' : value(c.field, c.from);
            const to = c.field === 'status' ? statusLabelAt(c, 'to') ?? '—' : value(c.field, c.to);
            return (
              <li key={i} title={`${fieldLabel(c.field)}: ${from} → ${to}`}>
                <Change label={fieldLabel(c.field)} from={from} to={to} />
              </li>
            );
          })}
        </ul>
        {skipped?.map((s, i) => (
          <div key={i} className="history-detail">couldn’t restore {fieldLabel(s.field)} — {s.reason}</div>
        ))}
        </>
      );
    }
    // A deleted task state: where the tasks that used it went.
    if (typeof p.movedTasks === 'number' && p.movedTasks > 0) {
      return <div className="history-detail">moved {p.movedTasks} {p.movedTasks === 1 ? 'task' : 'tasks'} to “{String(p.moveToLabel ?? p.moveTo)}”</div>;
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

  /** "to Design" / "here from Design" — a move reads from whichever end you are looking at. */
  function moveNote(payload: unknown): string | null {
    const p = payload as { fromTabId?: string; toTabId?: string } | null;
    if (!p?.toTabId) return null;
    const name = (tabId?: string) => (tabId && tabs[tabId]?.name) || 'another board';
    if (kind === 'tab' && p.toTabId === id) return `here from ${name(p.fromTabId)}`;
    return `to ${name(p.toTabId)}`;
  }

  const isTask = kind === 'task';
  const loading = entries === null || (isTask && commentsLoading && !comments);

  /** The row's sentence as plain text — the tooltip for when the line is cut short. */
  function sentence(e: HistoryEntry): string {
    const subject = !isTask && e.targetType === 'task' ? ` “${e.subject || 'untitled task'}”` : '';
    const move = e.action === 'task_move' ? moveNote(e.payload) : null;
    return `${actionVerb(e.action, e.payload)}${subject}${move ? ` ${move}` : ''}`;
  }

  /** A change row. On a board it is one line under a day heading, so its time is a clock time. */
  function historyRow(item: Extract<Item, { kind: 'history' }>) {
    const e = item.entry;
    const move = e.action === 'task_move' ? moveNote(e.payload) : null;
    return (
      <li key={e.id} className="history-entry">
        <div className="history-line">
          <span className="history-who">
            <span className="history-actor" title={e.actorEmail ?? undefined}>
              {e.actorEmail?.split('@')[0] ?? e.actorId ?? 'system'}
            </span>
            <ViaBadge label={patNameOf(e.payload)} />
          </span>
          <span className="history-verb" title={sentence(e)}>
            {actionVerb(e.action, e.payload)}
            {/* A board's history is mostly its tasks, so each row has to say WHICH. */}
            {!isTask && e.targetType === 'task' && (
              <> <span className="history-subject">“{e.subject || 'untitled task'}”</span></>
            )}
            {move && <> {move}</>}
          </span>
          <time className="history-time" dateTime={e.createdAt} title={formatTimestamp(e.createdAt)}>
            {isTask ? timeAgo(e.createdAt) : clockTime(e.createdAt)}
          </time>
          {/* Every entry is a point this task can be put back to — except the newest,
              which is where it already is. */}
          {isTask && item.laterCount > 0 && (
            <button
              className="btn ghost tiny history-restore"
              disabled={busy !== null}
              onClick={() => void restoreTo(e, item.laterCount)}
              title={`Restore the task to how it was at ${formatTimestamp(e.createdAt)}`}
            >
              {busy === e.id ? '…' : 'Restore'}
            </button>
          )}
        </div>
        {/* The snapshot/created lines only repeat the title the row now names. */}
        {isTask || e.targetType !== 'task' || hasChanges(e.payload) ? details(e.payload) : null}
      </li>
    );
  }

  /** The list body: on a board, rows grouped under day headings; on a task, the plain timeline. */
  const rows: React.ReactNode[] = [];
  let day = '';
  for (const item of items) {
    if (!isTask) {
      const heading = dayHeading(item.at);
      if (heading !== day) {
        day = heading;
        rows.push(<li key={`day-${item.at}`} className="history-day">{heading}</li>);
      }
    }
    rows.push(
      item.kind === 'comment' ? (
        <CommentItem
          key={item.comment.id}
          comment={item.comment}
          replies={item.replies}
          tabId={boardId}
          taskId={id}
          meId={meId}
        />
      ) : (
        historyRow(item)
      ),
    );
  }

  const panel = (
      <div
        className={`modal history-panel ${isTask ? '' : 'is-board'} ${embedded ? 'is-embedded' : ''}`}
        onClick={embedded ? undefined : (e) => e.stopPropagation()}
      >
        {!embedded && (
          <header className="modal-head">
            <h2>{isTask ? 'Activity' : 'History'} <span className="modal-head-sub">{title}</span></h2>
            <button className="icon-btn" onClick={onClose} aria-label="close">✕</button>
          </header>
        )}

        {error && <Notice>{error}</Notice>}
        {commentsError && <Notice>{commentsError}</Notice>}
        {note && <div className="history-note">{note}</div>}
        {historyDenied && <div className="history-note">Change history is available to editors of this board.</div>}

        {/* The one scroller in the drawer: head, notices, toggle and composer stay put around it. */}
        <ul className="history-list">
          {/* A task reads oldest-first, so its older changes are fetched from the top — on request
              only, since this sits in view the moment the list opens. */}
          {isTask && showHistory && cursor && (
            <li><LoadMore hasMore busy={loadingMore} onLoad={() => void loadMore()} label="Show earlier changes" auto={false} /></li>
          )}
          {rows}
          {!loading && items.length === 0 && (
            <EmptyState as="li">{isTask ? 'Nothing yet — say something below.' : 'No history yet.'}</EmptyState>
          )}
          {loading && !error && <Loading as="li" />}
          {!isTask && !loading && items.length > 0 && (
            <li><LoadMore hasMore={!!cursor} busy={loadingMore} onLoad={() => void loadMore()} endLabel="That’s the whole history." /></li>
          )}
        </ul>

        {/* The fold. Placed under the timeline, not above it, so it reads as "there is more
            underneath this" rather than as a filter over what you are looking at. */}
        {isTask && !historyDenied && historyCount > 0 && (
          <button type="button" className="btn ghost tiny history-toggle" onClick={() => setShowHistory((v) => !v)}>
            {showHistory
              ? 'Hide change history'
              : `Show change history (${historyCountLabel})`}
          </button>
        )}

        {isTask && (
          <CommentComposer tabId={boardId} onSubmit={(body) => void post(id, boardId, body)} />
        )}
      </div>
  );

  if (embedded) return panel;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      {panel}
    </div>
  );
}
