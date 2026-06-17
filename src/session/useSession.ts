// Session/auth controller. Owns the auth gate state and orchestrates hydration of
// the main store from the server, plus starting the persistence subscription.

import { create } from 'zustand';
import { auth, getState, setWriteErrorHandler, type SessionUser } from '../api/client';
import { startPersistence, setBaseline, suspendPersistence, resumePersistence } from '../api/persist';
import { useStore } from '../store';
import type { RootState } from '../types';

type Status = 'loading' | 'unauthenticated' | 'ready';

let persistenceStarted = false;

/** Pull authoritative state, hydrate the store, and (re)set the persistence baseline. */
async function loadState(): Promise<void> {
  suspendPersistence();
  const state = (await getState()) as RootState;
  useStore.getState().hydrate(state);
  resumePersistence();
  if (!persistenceStarted) {
    startPersistence();
    persistenceStarted = true;
  } else {
    setBaseline(useStore.getState());
  }
}

/** Recover from a failed write by discarding local optimistic state and re-pulling. */
async function repull(): Promise<void> {
  suspendPersistence();
  try {
    const state = (await getState()) as RootState;
    useStore.getState().hydrate(state);
    setBaseline(useStore.getState());
  } finally {
    resumePersistence();
  }
}

interface SessionState {
  status: Status;
  user: SessionUser | null;
  error: string | null;
  init(): Promise<void>;
  login(email: string, password: string): Promise<void>;
  signup(email: string, password: string, inviteCode: string): Promise<void>;
  logout(): Promise<void>;
}

export const useSession = create<SessionState>((set) => ({
  status: 'loading',
  user: null,
  error: null,

  async init() {
    setWriteErrorHandler(() => {
      void repull();
    });
    try {
      const { user } = await auth.me();
      await loadState();
      set({ user, status: 'ready', error: null });
    } catch {
      set({ status: 'unauthenticated' });
    }
  },

  async login(email, password) {
    const { user } = await auth.login(email, password);
    await loadState();
    set({ user, status: 'ready', error: null });
  },

  async signup(email, password, inviteCode) {
    const { user } = await auth.signup(email, password, inviteCode);
    await loadState();
    set({ user, status: 'ready', error: null });
  },

  async logout() {
    await auth.logout();
    set({ user: null, status: 'unauthenticated', error: null });
  },
}));
