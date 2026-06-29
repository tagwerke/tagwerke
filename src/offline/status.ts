// Tiny reactive store for connectivity + pending-write state, surfaced in the UI
// (the topbar offline pill) and read by the outbox/session to decide flush timing.
import { create } from 'zustand';

interface OfflineState {
  online: boolean;
  /** Number of mutations waiting in the durable outbox. */
  pending: number;
  /** True while the outbox is actively flushing to the server. */
  syncing: boolean;
  setOnline(online: boolean): void;
  setPending(pending: number): void;
  setSyncing(syncing: boolean): void;
}

export const useOffline = create<OfflineState>((set) => ({
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  pending: 0,
  syncing: false,
  setOnline: (online) => set({ online }),
  setPending: (pending) => set({ pending }),
  setSyncing: (syncing) => set({ syncing }),
}));

// Non-reactive setters for use outside React (outbox loop, fetch wrapper).
export const offline = {
  setOnline: (v: boolean) => useOffline.getState().setOnline(v),
  setPending: (v: number) => useOffline.getState().setPending(v),
  setSyncing: (v: boolean) => useOffline.getState().setSyncing(v),
  isOnline: () => useOffline.getState().online,
};
