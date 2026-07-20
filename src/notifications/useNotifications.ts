// Notification feed store (NOTIFICATIONS.md, Phase 3). A small standalone Zustand store, like
// useSession — deliberately NOT part of the main RootState store, so a state hydrate/resync
// (which replaces RootState) never clobbers the feed, and logout can clear it independently.
//
// Fed two ways: load() pulls the latest slice on boot, and receive() is called by the realtime
// socket (src/realtime/socket.ts) for each live 'notification' frame. Read-state writes are
// optimistic (flip locally, fire-and-forget to the server).

import { create } from 'zustand';
import { api } from '../api/client';
import type { ID, Notification } from '../types';

interface NotificationsState {
  items: Notification[];
  unread: number;
  loaded: boolean;
  /** Pull the latest feed slice + unread count from the server. */
  load(): Promise<void>;
  /** Apply a live notification pushed over the socket (prepend, bump unread, dedupe by id). */
  receive(n: Notification): void;
  /** Mark one notification read (optimistic + server). */
  markRead(id: ID): void;
  /** Mark every notification read (optimistic + server). */
  markAllRead(): void;
  /** Delete the whole feed (optimistic + server). */
  clearAll(): void;
  /** Drop all local feed state (logout). */
  reset(): void;
}

const MAX_ITEMS = 50; // keep the in-memory feed bounded, matching the server's FEED_LIMIT

export const useNotifications = create<NotificationsState>((set, get) => ({
  items: [],
  unread: 0,
  loaded: false,

  async load() {
    try {
      const { notifications, unread } = await api.notifications.list();
      set({ items: notifications, unread, loaded: true });
    } catch {
      /* offline / transient — the socket will still deliver live ones; retry on next boot */
    }
  },

  receive(n) {
    set((s) => {
      if (s.items.some((i) => i.id === n.id)) return s; // dedupe (e.g. load + live race)
      const items = [n, ...s.items].slice(0, MAX_ITEMS);
      return { items, unread: s.unread + (n.readAt ? 0 : 1) };
    });
  },

  markRead(id) {
    const nowIso = new Date().toISOString();
    let changed = false;
    set((s) => {
      const items = s.items.map((i) => {
        if (i.id === id && !i.readAt) {
          changed = true;
          return { ...i, readAt: nowIso };
        }
        return i;
      });
      return changed ? { items, unread: Math.max(0, s.unread - 1) } : s;
    });
    if (changed) void api.notifications.markRead(id).catch(() => {});
  },

  markAllRead() {
    if (get().unread === 0) return;
    const nowIso = new Date().toISOString();
    set((s) => ({ items: s.items.map((i) => (i.readAt ? i : { ...i, readAt: nowIso })), unread: 0 }));
    void api.notifications.markAllRead().catch(() => {});
  },

  clearAll() {
    if (get().items.length === 0) return;
    set({ items: [], unread: 0 });
    void api.notifications.clearAll().catch(() => {});
  },

  reset() {
    set({ items: [], unread: 0, loaded: false });
  },
}));
