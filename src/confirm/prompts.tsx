// Shared confirm copy for actions that are triggered from more than one surface. Keeping the
// wording in one place is the point: the same action described three different ways is how a UI
// ends up telling users something that isn't true.

import { useOffline } from '../offline/status';
import { askConfirm } from './useConfirm';

/**
 * Deleting a space. Reachable from the sidebar (SpaceForm), the board grid (Board) and the filter
 * popover (FilterPanel).
 *
 * The copy describes what the SERVER does — a space is a personal category, and deleting one
 * re-files the caller's boards under a fallback category rather than deleting them
 * (server/routes/projects.ts). Note the client store still drops those boards from local state on
 * delete, so the screen briefly disagrees with this text until a reload; that divergence is a
 * separate fix, and the wording here should stay true to the durable outcome.
 */
export function confirmDeleteSpace(name: string, boardCount: number): Promise<boolean> {
  return askConfirm({
    title: `Delete the space “${name}”?`,
    body:
      boardCount > 0 ? (
        <p>
          Its {boardCount === 1 ? 'board moves' : `${boardCount} boards move`} to another space —
          {boardCount === 1 ? ' it is' : ' they are'} not deleted. The space itself is gone for good.
        </p>
      ) : (
        <p>The space is empty, so nothing else is affected. This can't be undone.</p>
      ),
    confirmLabel: 'Delete space',
  });
}

/**
 * Signing out. CONDITIONAL by design: signing out is normally reversible (sign back in), so
 * prompting every time would be pure friction. It stops being reversible when the durable outbox
 * still holds writes — logout calls clearOutbox(), which discards them (src/offline/outbox.ts).
 * That is the only case worth interrupting, and it's the one nobody expects.
 */
export function confirmSignOut(): Promise<boolean> {
  const pending = useOffline.getState().pending;
  if (pending === 0) return Promise.resolve(true);
  return askConfirm({
    title: 'Sign out with unsaved changes?',
    body: (
      <p>
        {pending === 1 ? '1 change hasn’t' : `${pending} changes haven’t`} reached the server yet. Signing out
        now discards {pending === 1 ? 'it' : 'them'}. Reconnect and wait for the sync to finish to keep{' '}
        {pending === 1 ? 'it' : 'them'}.
      </p>
    ),
    confirmLabel: 'Discard and sign out',
  });
}

/**
 * Restoring a task to an earlier point in its history (HistoryDrawer).
 *
 * Worth interrupting for, even though it is undoable: the drawer shows one row's worth of change
 * ("changed status"), but the restore reaches back past EVERY change made since — which is the one
 * thing the row on screen doesn't say. The copy's job is to name that, and to be clear it lands as
 * a normal edit that the same drawer can walk back.
 */
export function confirmRevertTask(when: string, laterCount: number): Promise<boolean> {
  return askConfirm({
    title: 'Restore this task to how it was?',
    body: (
      <p>
        Its title and details go back to {when}
        {laterCount > 0 ? `, undoing ${laterCount === 1 ? 'the 1 change' : `all ${laterCount} changes`} made since` : ''}. Where the
        task sits on the board doesn't move. This is recorded as an edit, so you can restore it back
        from this same list.
      </p>
    ),
    confirmLabel: 'Restore',
    danger: false,
  });
}

/**
 * Deleting a calendar event. Reachable from the board's Events panel, the calendar's event editor,
 * and Delete/Backspace on a focused event card. Unlike tasks, events are NOT soft-deleted — there
 * is no Trash row and no restore, which is the fact this copy has to carry.
 */
export function confirmDeleteEvent(opts: { title?: string | null; recurring?: boolean; shared?: boolean }): Promise<boolean> {
  const name = opts.title?.trim();
  return askConfirm({
    title: name ? `Delete “${name}”?` : 'Delete this event?',
    body: (
      <p>
        {opts.shared
          ? 'It disappears for everyone on the board, along with their RSVPs.'
          : 'It’s removed from your calendar.'}
        {opts.recurring ? ' This event repeats — every one of its dates goes too.' : ''} Events have no
        Trash, so this can’t be undone.
      </p>
    ),
    confirmLabel: 'Delete event',
  });
}

/**
 * Deleting a comment (the task Activity drawer).
 *
 * Worth interrupting for because the outcome is not what "delete" usually means here: unlike a
 * task, a comment leaves a visible tombstone in the thread — deliberately, so replies to it still
 * make sense (COMMENTS_PLAN.md D7) — and unlike Trash, there is no restore. Deleting someone
 * else's comment is a moderation act, so the copy says whose it is.
 */
export function confirmDeleteComment(opts: { authorName?: string | null; mine: boolean }): Promise<boolean> {
  return askConfirm({
    title: opts.mine ? 'Delete your comment?' : `Delete ${opts.authorName ?? 'this member'}’s comment?`,
    body: (
      <p>
        The text goes for everyone. A “comment deleted” line stays in its place so replies still make
        sense, and the deletion is recorded in the audit log. There is no Trash for comments — this
        can’t be undone.
      </p>
    ),
    confirmLabel: 'Delete comment',
  });
}
