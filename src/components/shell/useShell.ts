// The shell's own state: the boards open as tabs, which bar holds the tabs (the other one holds the
// header), and the app settings modal. Tabs and layout are per-viewer conveniences, so they live in
// localStorage, like a board's remembered filters — a browser that refuses it just starts with no
// tabs and the default layout.
//
// Opening a board anywhere (a card, search, a link, back/forward) opens its tab: the module
// subscribes to the main store's activeTabId, so no caller has to remember to.

import { create } from 'zustand';
import { useStore } from '../../store';
import type { ID } from '../../types';

/** Which bar holds the tabs. The other bar holds the header. */
export type NavLayout = 'tabs-side' | 'tabs-top';
export type AppSettingsSection = 'spaces' | 'layout' | 'security';

const TABS_KEY = 'tagwerke.openTabs';
const LAYOUT_KEY = 'tagwerke.navLayout';

function readTabs(): ID[] {
  try {
    const raw = JSON.parse(localStorage.getItem(TABS_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x): x is ID => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function readLayout(): NavLayout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'tabs-top' ? 'tabs-top' : 'tabs-side';
  } catch {
    return 'tabs-side';
  }
}
function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage refused: the tabs just won't survive a refresh */
  }
}

interface ShellState {
  /** Open board ids, in tab order. May hold a board since deleted or left — readers skip those. */
  openIds: ID[];
  layout: NavLayout;
  /** The open app settings section, or null when the modal is closed. */
  appSettings: AppSettingsSection | null;
  openTab(id: ID): void;
  /** Close a board's tab. Closing the one on screen moves to its neighbour, or home. */
  closeTab(id: ID): void;
  setLayout(layout: NavLayout): void;
  setAppSettings(section: AppSettingsSection | null): void;
}

export const useShell = create<ShellState>((set, get) => ({
  openIds: readTabs(),
  layout: readLayout(),
  appSettings: null,

  openTab(id) {
    if (get().openIds.includes(id)) return;
    const openIds = [...get().openIds, id];
    set({ openIds });
    write(TABS_KEY, JSON.stringify(openIds));
  },

  closeTab(id) {
    const before = get().openIds;
    const at = before.indexOf(id);
    if (at < 0) return;
    const openIds = before.filter((x) => x !== id);
    set({ openIds });
    write(TABS_KEY, JSON.stringify(openIds));

    const st = useStore.getState();
    if (st.activeTabId !== id) return;
    // Like a browser: the tab that slid into the closed one's place, else the one before it.
    const live = (x: ID | undefined) => (x && st.tabs[x] ? x : undefined);
    const next = openIds.slice(at).find(live) ?? openIds.slice(0, at).reverse().find(live) ?? null;
    st.setActiveTab(next);
  },

  setLayout(layout) {
    set({ layout });
    write(LAYOUT_KEY, layout);
  },

  setAppSettings(section) {
    set({ appSettings: section });
  },
}));

useStore.subscribe((s, prev) => {
  if (s.activeTabId && s.activeTabId !== prev.activeTabId) useShell.getState().openTab(s.activeTabId);
});
