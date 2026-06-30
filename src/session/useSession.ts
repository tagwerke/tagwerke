// Session/auth controller. Owns the auth gate state and orchestrates hydration of
// the main store from the server, plus starting the persistence subscription.
//
// Offline-aware: if the network is unreachable on boot we fall back to the cached
// identity + last state snapshot (IndexedDB) so the app opens and stays editable;
// the durable outbox replays queued writes once connectivity returns.

import { create } from 'zustand';
import { auth, getState, setWriteErrorHandler, type SessionUser } from '../api/client';
import { startPersistence, setBaseline, suspendPersistence, resumePersistence } from '../api/persist';
import { startOutbox, clearOutbox } from '../offline/outbox';
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

/** Recover from a failed write by discarding local optimistic state and re-pulling. */
async function repull(): Promise<void> {
  suspendPersistence();
  try {
    const state = (await getState()) as RootState;
    useStore.getState().hydrate(state);
    setBaseline(useStore.getState());
    saveSnapshot(useStore.getState());
  } catch {
    /* offline / transient — keep local state; the outbox will reconcile later */
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

  async logout() {
    try {
      await auth.logout();
    } catch {
      /* offline — clear local session anyway */
    }
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
