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
import { startOutbox, clearOutbox, pendingTaskIds } from '../offline/outbox';
import { saveSnapshot, loadSnapshot, saveCachedUser, loadCachedUser, clearSnapshot } from '../offline/snapshot';
import { offline } from '../offline/status';
import { useStore } from '../store';
import type { RootState } from '../types';

type Status = 'loading' | 'unauthenticated' | 'ready';

let persistenceStarted = false;

/** Hydrate the store from a state object and (re)set the persistence baseline + snapshot. */
function hydrateAndPersist(state: RootState): void {
  suspendPersistence();
  useStore.getState().hydrate(state);
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
}

/** Pull authoritative state; if the network is down, boot from the last snapshot. */
async function loadState(): Promise<void> {
  let state: RootState;
  try {
    state = (await getState()) as RootState;
  } catch (e) {
    const snap = await loadSnapshot();
    if (!snap) throw e; // nothing cached → genuinely can't proceed
    offline.setOnline(false);
    state = snap;
  }
  hydrateAndPersist(state);
}

/** Re-pull authoritative state on a resync (reconnect / board-list / failed write), WITHOUT
 *  losing optimistic local edits. The fetch happens outside any suspend window so a change made
 *  during the round-trip still schedules normally; then flush + hydrate + baseline run as one
 *  synchronous block (no `await`) so nothing can interleave, and tasks with an un-acked write are
 *  preserved rather than reverted. This is the same safety `applyRemote` (socket.ts) already has. */
async function repull(): Promise<void> {
  let state: RootState;
  try {
    state = (await getState()) as RootState;
  } catch {
    return; // offline / transient — keep local state; the outbox will reconcile later
  }
  // --- synchronous region: no `await` below, so no local edit can slip in unprotected ---
  flush(); // debounced local edits (incl. any made during the fetch) → durable outbox
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
