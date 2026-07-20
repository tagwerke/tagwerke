// Session/auth controller. Owns the auth gate state and orchestrates hydration of
// the main store from the server, plus starting the persistence subscription.
//
// Offline-aware: if the network is unreachable on boot we fall back to the cached
// identity + last state snapshot (IndexedDB) so the app opens and stays editable;
// the durable outbox replays queued writes once connectivity returns.

import { create } from 'zustand';
import { auth, getState, setWriteErrorHandler, type SessionUser } from '../api/client';
import { startPersistence, setBaseline, suspendPersistence, resumePersistence, flush } from '../api/persist';
import { startRealtime, stopRealtime } from '../realtime/socket';
import { useNotifications } from '../notifications/useNotifications';
import { startOutbox, clearOutbox, pendingTaskIds, outboxIdle } from '../offline/outbox';
import { saveSnapshot, loadSnapshot, saveCachedUser, loadCachedUser, clearSnapshot } from '../offline/snapshot';
import { offline } from '../offline/status';
import { useStore } from '../store';
import type { ID, RootState } from '../types';

type Status = 'loading' | 'unauthenticated' | 'ready';

let persistenceStarted = false;

/** Hydrate the store from a state object and (re)set the persistence baseline + snapshot.
 *  `keepTaskIds` protects tasks with an un-acked write from being reverted by the hydrate (used on
 *  the online boot path, where a prior offline session's writes may still be replaying). */
function hydrateAndPersist(state: RootState, keepTaskIds?: Set<ID>): void {
  suspendPersistence();
  useStore.getState().hydrate(state, keepTaskIds);
  resumePersistence();
  if (!persistenceStarted) {
    startPersistence();
    persistenceStarted = true;
  } else {
    setBaseline(useStore.getState());
  }
  saveSnapshot(useStore.getState());
  // Live updates: connect the realtime socket (idempotent). On a reconnect it re-pulls
  // authoritative state to catch anything missed while disconnected.
  startRealtime({ onResync: () => void repull() });
  // Pull the notification feed for this login (live ones then arrive over the socket).
  // hydrateAndPersist runs once per login — repull()/resync does NOT come through here.
  void useNotifications.getState().load();
}

/** Pull authoritative state; if the network is down, boot from the last snapshot. */
async function loadState(): Promise<void> {
  // Read-your-writes on boot too: a prior offline session's queued writes (replayed by
  // startOutbox) must commit before we read, or getState returns state that predates them and
  // the hydrate reverts them. Drain first (bounded), then read; belt-and-suspenders preserve any
  // still-queued task via `pendingTaskIds()`.
  await drainForRead();
  let state: RootState;
  try {
    state = (await getState()) as RootState;
  } catch (e) {
    const snap = await loadSnapshot();
    if (!snap) throw e; // nothing cached → genuinely can't proceed
    offline.setOnline(false);
    hydrateAndPersist(snap); // snapshot IS local truth — no pending-preserve needed
    return;
  }
  hydrateAndPersist(state, pendingTaskIds());
}

/** Longest we'll wait for the outbox to drain before an authoritative read. If writes are still
 *  stuck after this (server flaky), we read anyway — whatever is still queued stays protected by
 *  `pendingTaskIds()`, so nothing is lost; we just accept a possibly-stale field for those tasks. */
const READ_DRAIN_CAP_MS = 4000;

/** Wait for the outbox to fully drain, but never hang a resync on a stuck/offline queue. */
function drainForRead(): Promise<void> {
  return Promise.race([
    outboxIdle(),
    new Promise<void>((resolve) => setTimeout(resolve, READ_DRAIN_CAP_MS)),
  ]);
}

/** Re-pull authoritative state on a resync (reconnect / board-list / failed write), WITHOUT
 *  losing optimistic local edits.
 *
 *  Read-your-writes: an authoritative full-state read must not be applied if it could predate a
 *  local write, or it hydrates stale data OVER a change we already made. So we (1) flush any
 *  debounced edit into the durable outbox and (2) wait for the outbox to drain, so the server has
 *  COMMITTED our writes before it computes the state we read. Only then do we (3) getState().
 *  `pendingTaskIds()` alone is not enough — it protects a write only while it's still queued; once
 *  acked, a resync `GET /api/state` that raced ahead of it would silently revert the change (the
 *  exact "server check ran after the change → change never persisted" bug).
 *
 *  A late edit made DURING the read is still covered: the post-fetch flush + hydrate + baseline run
 *  as one synchronous block (no `await`) so nothing interleaves, and any task with an un-acked write
 *  is preserved rather than reverted — the same belt-and-suspenders `applyRemote` (socket.ts) has. */
async function repull(): Promise<void> {
  flush(); // debounced edits → durable outbox, so the drain below actually waits for them
  await drainForRead(); // read-your-writes: let our own writes commit before we read

  let state: RootState;
  try {
    state = (await getState()) as RootState;
  } catch {
    return; // offline / transient — keep local state; the outbox will reconcile later
  }
  // --- synchronous region: no `await` below, so no local edit can slip in unprotected ---
  flush(); // any edit made DURING the read → durable outbox
  const pending = pendingTaskIds(); // ids to protect from the rehydrate (they win until acked)
  suspendPersistence();
  try {
    useStore.getState().hydrate(state, pending);
    setBaseline(useStore.getState());
    saveSnapshot(useStore.getState());
  } finally {
    resumePersistence();
  }
}

interface SessionState {
  status: Status;
  user: SessionUser | null;
  error: string | null;
  init(): Promise<void>;
  // Resolves `{ totpRequired: true }` when a second factor is needed (no session yet).
  login(email: string, password: string, totp?: string): Promise<{ totpRequired?: boolean }>;
  signup(email: string, password: string, inviteCode: string): Promise<void>;
  passkeyLogin(): Promise<void>;
  passkeyConditional(): Promise<void>;
  logout(): Promise<void>;
  refreshUser(): Promise<void>;
}

export const useSession = create<SessionState>((set) => ({
  status: 'loading',
  user: null,
  error: null,

  async init() {
    setWriteErrorHandler(() => {
      void repull();
    });
    void startOutbox(); // replay any writes queued in a prior offline session
    try {
      const { user } = await auth.me();
      saveCachedUser(user);
      await loadState();
      set({ user, status: 'ready', error: null });
    } catch {
      // Distinguish "no network" (boot offline from cache) from a real 401.
      const reallyOffline = typeof navigator !== 'undefined' && !navigator.onLine;
      const [cachedUser, snap] = await Promise.all([loadCachedUser(), loadSnapshot()]);
      if (reallyOffline && cachedUser && snap) {
        offline.setOnline(false);
        hydrateAndPersist(snap);
        set({ user: cachedUser, status: 'ready', error: null });
      } else {
        if (!reallyOffline) clearSnapshot(); // session truly gone → don't keep stale data
        set({ status: 'unauthenticated' });
      }
    }
  },

  async login(email, password, totp) {
    const res = await auth.login(email, password, totp);
    if (!res.user) return { totpRequired: !!res.totpRequired };
    saveCachedUser(res.user);
    await loadState();
    set({ user: res.user, status: 'ready', error: null });
    return {};
  },

  async signup(email, password, inviteCode) {
    const { user } = await auth.signup(email, password, inviteCode);
    saveCachedUser(user);
    await loadState();
    set({ user, status: 'ready', error: null });
  },

  async passkeyLogin() {
    const { user } = await auth.passkey.login();
    saveCachedUser(user);
    await loadState();
    set({ user, status: 'ready', error: null });
  },

  async passkeyConditional() {
    const { user } = await auth.passkey.loginConditional();
    saveCachedUser(user);
    await loadState();
    set({ user, status: 'ready', error: null });
  },

  async logout() {
    try {
      await auth.logout();
    } catch {
      /* offline — clear local session anyway */
    }
    stopRealtime();
    clearSnapshot();
    clearOutbox();
    useNotifications.getState().reset();
    set({ user: null, status: 'unauthenticated', error: null });
  },

  async refreshUser() {
    try {
      const { user } = await auth.me();
      saveCachedUser(user);
      set({ user });
    } catch {
      /* offline / transient — keep the cached user */
    }
  },
}));
