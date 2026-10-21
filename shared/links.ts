// Where a notification should take you. Shared so the server can put the ready-made path in a push
// payload (the service worker can't import app code) and the in-app feed can use the same one.
//
//   comment on a task    → /b/:board/task/:task?comment=:comment   (the task page, scrolled to it)
//   assigned / review    → /b/:board/task/:task
//   anything on a board  → /b/:board
//   account-level        → /
//
// These match the routes the app already parses (src/util/router.ts). The `comment` query is only
// read by the task page's thread, to scroll to and highlight that comment.

export interface NotificationTarget {
  tabId?: string | null;
  taskId?: string | null;
  commentId?: string | null;
}

export function notificationPath({ tabId, taskId, commentId }: NotificationTarget): string {
  if (!tabId) return '/';
  const board = `/b/${encodeURIComponent(tabId)}`;
  if (!taskId) return board;
  const task = `${board}/task/${encodeURIComponent(taskId)}`;
  return commentId ? `${task}?comment=${encodeURIComponent(commentId)}` : task;
}
