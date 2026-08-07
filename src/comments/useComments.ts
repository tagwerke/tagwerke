// Comment threads (COMMENTS_PLAN.md). A small standalone Zustand store, like useNotifications —
// deliberately NOT part of RootState, because threads are loaded lazily per task (only when a
// drawer opens) and a state hydrate/resync, which replaces RootState wholesale, has no business
// discarding an open conversation.
//
// Fed three ways: load() pulls a task's thread when its drawer opens, the local write actions
// append optimistically, and receive() applies live frames from the realtime socket. All three
// converge through one rule — a comment is identified by its id, and an id we already hold is
// never appended twice. That is what makes our own echo (the server broadcasts the comment we
// just posted back to us) a no-op instead of a duplicate.
//
// The COUNT badge lives in RootState (it arrives with /api/state for every visible task); this
// store nudges it as comments come and go.

import { create } from 'zustand';
import { nanoid } from 'nanoid';
import { api, ApiError } from '../api/client';
import { useStore } from '../store';
import { useSession } from '../session/useSession';
import type { Comment, ID } from '../types';

interface CommentsState {
  /** Loaded threads, keyed by task id, oldest comment first. */
  byTask: Record<ID, Comment[]>;
  /** Tasks whose thread is currently being fetched. */
  loading: Record<ID, boolean>;
  /** Last error per task (thread load / write), shown inline in the drawer. */
  error: Record<ID, string | null>;

  /** Pull a task's thread. Authoritative — it also corrects the count badge. */
  load(taskId: ID): Promise<void>;
  /** Post a comment (optimistic + outbox). Resolves once the write has been submitted. */
  post(taskId: ID, tabId: ID, body: string, parentCommentId?: ID | null): Promise<void>;
  /** Edit one's own comment (optimistic + outbox). */
  edit(taskId: ID, commentId: ID, body: string): Promise<void>;
  /** Soft-delete a comment (optimistic + outbox) — it becomes a tombstone, not a hole. */
  remove(taskId: ID, commentId: ID): Promise<void>;
  /** Apply a live 'comment' frame from the socket. Idempotent, and ignores unloaded threads. */
  receive(action: 'create' | 'update' | 'delete', comment: Comment): void;
  /** Drop every loaded thread (logout). */
  reset(): void;
}

/** Replace one comment in a thread; returns the same array when the id isn't present. */
function replaceIn(list: Comment[], comment: Comment): Comment[] {
  const i = list.findIndex((c) => c.id === comment.id);
  if (i === -1) return list;
  const next = list.slice();
  next[i] = comment;
  return next;
}

function message(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message.replace(/^.*-> \d+\s*/, '') || fallback : fallback;
}

export const useComments = create<CommentsState>((set, get) => ({
  byTask: {},
  loading: {},
  error: {},

  async load(taskId) {
    set((s) => ({ loading: { ...s.loading, [taskId]: true }, error: { ...s.error, [taskId]: null } }));
    try {
      const { comments } = await api.comments.list(taskId);
      set((s) => ({ byTask: { ...s.byTask, [taskId]: comments }, loading: { ...s.loading, [taskId]: false } }));
      // The thread we just read is the truth about how many live comments the task has.
      useStore.getState().setCommentCount(taskId, comments.filter((c) => !c.deleted).length);
    } catch (e) {
      set((s) => ({
        loading: { ...s.loading, [taskId]: false },
        error: { ...s.error, [taskId]: message(e, 'couldn’t load comments') },
      }));
    }
  },

  async post(taskId, tabId, body, parentCommentId) {
    const text = body.trim();
    if (!text) return;
    const me = useSession.getState().user;
    const id = nanoid();
    // Optimistic row. `mentions` is left empty on purpose: the server derives the real list
    // (dropping anyone who isn't a board member), and guessing it here would mean the local copy
    // claims recipients the server may not have notified.
    const optimistic: Comment = {
      id,
      taskId,
      tabId,
      authorId: me?.id ?? null,
      authorEmail: me?.email ?? null,
      authorName: me?.email ? me.email.split('@')[0] : null,
      parentCommentId: parentCommentId ?? null,
      body: text,
      mentions: [],
      deleted: false,
      createdAt: new Date().toISOString(),
      editedAt: null,
    };
    set((s) => ({
      byTask: { ...s.byTask, [taskId]: [...(s.byTask[taskId] ?? []), optimistic] },
      error: { ...s.error, [taskId]: null },
    }));
    useStore.getState().bumpCommentCount(taskId, 1);
    // The outbox owns delivery and retry from here. A server rejection drops the op and triggers
    // the session's authoritative re-pull, which is also when a bad optimistic row disappears.
    await api.comments.create(taskId, { id, body: text, parentCommentId: parentCommentId ?? null });
  },

  async edit(taskId, commentId, body) {
    const text = body.trim();
    if (!text) return;
    const editedAt = new Date().toISOString();
    set((s) => {
      const list = s.byTask[taskId];
      if (!list) return s;
      const cur = list.find((c) => c.id === commentId);
      if (!cur) return s;
      return { byTask: { ...s.byTask, [taskId]: replaceIn(list, { ...cur, body: text, editedAt }) } };
    });
    await api.comments.update(commentId, text);
  },

  async remove(taskId, commentId) {
    let wasLive = false;
    set((s) => {
      const list = s.byTask[taskId];
      if (!list) return s;
      const cur = list.find((c) => c.id === commentId);
      if (!cur || cur.deleted) return s;
      wasLive = true;
      // Tombstone in place (D7) — same shape the server will broadcast back.
      return { byTask: { ...s.byTask, [taskId]: replaceIn(list, { ...cur, deleted: true, body: '', mentions: [] }) } };
    });
    if (wasLive) useStore.getState().bumpCommentCount(taskId, -1);
    await api.comments.remove(commentId);
  },

  receive(action, comment) {
    const { taskId } = comment;
    const list = get().byTask[taskId];
    // A thread nobody has open is not worth materializing from a single frame — it would be a
    // partial conversation. The count badge still moves, and load() fills the rest in on open.
    if (!list) {
      if (action === 'create') useStore.getState().bumpCommentCount(taskId, 1);
      else if (action === 'delete') useStore.getState().bumpCommentCount(taskId, -1);
      return;
    }
    const existing = list.find((c) => c.id === comment.id);

    if (action === 'create') {
      if (existing) return; // our own echo, or a duplicate frame — already here
      set((s) => ({ byTask: { ...s.byTask, [taskId]: [...(s.byTask[taskId] ?? []), comment] } }));
      useStore.getState().bumpCommentCount(taskId, 1);
      return;
    }
    if (!existing) return; // update/delete for something we never had
    if (action === 'delete' && !existing.deleted) useStore.getState().bumpCommentCount(taskId, -1);
    set((s) => ({ byTask: { ...s.byTask, [taskId]: replaceIn(s.byTask[taskId] ?? [], comment) } }));
  },

  reset() {
    set({ byTask: {}, loading: {}, error: {} });
  },
}));
