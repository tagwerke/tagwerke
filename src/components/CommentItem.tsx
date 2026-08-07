// One comment in a task's Activity timeline, plus its replies (COMMENTS_PLAN.md D4: one level,
// never a tree). Owns its own reply/edit state so the drawer above it stays a timeline and
// nothing else.
//
// Who can do what (D6): anyone on the board — including a `viewer` — may reply; only the AUTHOR
// may edit (an admin can remove someone's comment but never rewrite their words); the author or
// a board admin may delete, and the delete is soft, leaving the tombstone this renders.

import { useState } from 'react';
import { useComments } from '../comments/useComments';
import { confirmDeleteComment } from '../confirm/prompts';
import { CommentComposer } from './CommentComposer';
import { parseMentions } from '../../shared/mentions';
import { timeAgo } from '../util/dates';
import type { Comment, ID } from '../types';

/**
 * A comment body as text plus mention chips. The stored form is `@[name](userId)`; a reader should
 * see `@name`, and see it stand out when the name is theirs — a mention you can't spot is a
 * notification that arrived for no reason.
 */
function CommentBody({ body, meId }: { body: string; meId?: ID }) {
  const tokens = parseMentions(body);
  if (!tokens.length) return <span className="comment-text">{body}</span>;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  tokens.forEach((t, i) => {
    if (t.start > cursor) parts.push(<span key={`t${i}`}>{body.slice(cursor, t.start)}</span>);
    parts.push(
      <span key={`m${i}`} className={`comment-mention ${t.userId === meId ? 'me' : ''}`}>
        @{t.name}
      </span>,
    );
    cursor = t.end;
  });
  if (cursor < body.length) parts.push(<span key="tail">{body.slice(cursor)}</span>);
  return <span className="comment-text">{parts}</span>;
}

interface Props {
  comment: Comment;
  /** Replies to this comment, oldest first. Empty for a reply (there is no second level). */
  replies?: Comment[];
  tabId: ID;
  taskId: ID;
  meId?: ID;
  /** Board admin — may delete anyone's comment. */
  canModerate: boolean;
  /** False for a reply, which cannot itself be replied to (D4). */
  replyable?: boolean;
}

export function CommentItem({ comment, replies = [], tabId, taskId, meId, canModerate, replyable = true }: Props) {
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState(false);
  const post = useComments((s) => s.post);
  const edit = useComments((s) => s.edit);
  const remove = useComments((s) => s.remove);

  const mine = !!meId && comment.authorId === meId;
  const author = comment.authorName ?? 'deleted user';

  async function onDelete(): Promise<void> {
    if (!(await confirmDeleteComment({ authorName: comment.authorName, mine }))) return;
    void remove(taskId, comment.id);
  }

  return (
    <li className={`comment ${comment.deleted ? 'deleted' : ''}`}>
      <div className="comment-head">
        <span className="comment-avatar" aria-hidden>{author.charAt(0).toUpperCase()}</span>
        <span className="comment-author" title={comment.authorEmail ?? undefined}>{author}</span>
        <span className="comment-time" title={comment.createdAt}>{timeAgo(comment.createdAt)}</span>
        {comment.editedAt && !comment.deleted && <span className="comment-edited">edited</span>}
      </div>

      {comment.deleted ? (
        <div className="comment-body comment-tombstone">comment deleted</div>
      ) : editing ? (
        <CommentComposer
          tabId={tabId}
          initialValue={comment.body}
          submitLabel="Save"
          autoFocus
          onCancel={() => setEditing(false)}
          onSubmit={(body) => {
            void edit(taskId, comment.id, body);
            setEditing(false);
          }}
        />
      ) : (
        <div className="comment-body">
          <CommentBody body={comment.body} meId={meId} />
        </div>
      )}

      {!comment.deleted && !editing && (
        <div className="comment-actions">
          {replyable && (
            <button type="button" className="btn ghost tiny" onClick={() => setReplying((v) => !v)}>
              {replying ? 'Cancel' : 'Reply'}
            </button>
          )}
          {mine && (
            <button type="button" className="btn ghost tiny" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
          {(mine || canModerate) && (
            <button type="button" className="btn ghost tiny" onClick={() => void onDelete()}>
              Delete
            </button>
          )}
        </div>
      )}

      {(replies.length > 0 || replying) && (
        <ul className="comment-replies">
          {replies.map((r) => (
            <CommentItem
              key={r.id}
              comment={r}
              tabId={tabId}
              taskId={taskId}
              meId={meId}
              canModerate={canModerate}
              replyable={false}
            />
          ))}
          {replying && (
            <li className="comment-reply-composer">
              <CommentComposer
                tabId={tabId}
                autoFocus
                placeholder={`Reply to ${author} — @ to mention`}
                submitLabel="Reply"
                onCancel={() => setReplying(false)}
                onSubmit={(body) => {
                  void post(taskId, tabId, body, comment.id);
                  setReplying(false);
                }}
              />
            </li>
          )}
        </ul>
      )}
    </li>
  );
}
