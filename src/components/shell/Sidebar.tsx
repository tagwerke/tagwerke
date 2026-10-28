// The persistent left rail: the brand, then either the tabs or the header — whichever the top bar
// isn't showing (useShell's layout). Spaces live in Settings now, and the calendar is its own tab.

import { useStore } from '../../store';
import { NavTabs } from './NavTabs';
import { ShellHeader } from './ShellHeader';
import type { Panel } from '../../App';

export function Sidebar({ tabsHere, onOpen }: { tabsHere: boolean; onOpen: (panel: Panel) => void }) {
  const setActiveTab = useStore((s) => s.setActiveTab);
  const resetFilter = useStore((s) => s.resetFilter);

  return (
    <aside className="sidebar">
      <button className="brand sidebar-brand" onClick={() => { setActiveTab(null); resetFilter(); }} aria-label="Home">
        <span className="brand-mark" />
        <span className="brand-name">Tagwerke</span>
      </button>
      {tabsHere ? <NavTabs orientation="col" /> : <ShellHeader orientation="col" onOpen={onOpen} />}
    </aside>
  );
}
