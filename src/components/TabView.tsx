import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { TabEditor } from '../editor/Editor';
import { hexToRgba } from '../util/color';
import { SharePanel } from './SharePanel';
import { EventsPanel } from './EventsPanel';
import { BoardActivity } from './BoardActivity';

export function TabView({ tabId }: { tabId: string }) {
  const tab = useStore((s) => s.tabs[tabId]);
  const project = useStore((s) => (tab ? s.projects[tab.projectId] : undefined));
  const setActiveTab = useStore((s) => s.setActiveTab);
  const renameTab = useStore((s) => s.renameTab);
  const setTabStarred = useStore((s) => s.setTabStarred);
  const [sharing, setSharing] = useState(false);
  const [scheduling, setScheduling] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const target = e.target as HTMLElement;
        if (target?.closest('.ProseMirror')) return;
        setActiveTab(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setActiveTab]);

  if (!tab) return null;

  const accent = project?.color ?? '#888';
  const style = {
    '--page-accent': accent,
    '--page-accent-soft': hexToRgba(accent, 0.10),
  } as React.CSSProperties;

  return (
    <main className="tab-view" style={style}>
      <header className="tab-view-head">
        <button className="back-btn" onClick={() => setActiveTab(null)} aria-label="back">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="M10 3L4 8l6 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none"/></svg>
          <span>board</span>
        </button>
        <span className="tab-view-project">{project?.name}</span>
        <input
          className="tab-view-title"
          value={tab.name}
          onChange={(e) => renameTab(tab.id, e.target.value)}
        />
        <button
          className={`icon-btn star ${tab.starred ? 'on' : ''}`}
          onClick={() => setTabStarred(tab.id, !tab.starred)}
          aria-label="star"
          title={tab.starred ? 'unstar' : 'star'}
        >
          <svg viewBox="0 0 16 16" width="16" height="16"><path d="M8 1.7l1.9 4 4.4.5-3.3 3 .9 4.3L8 11.6l-3.9 1.9.9-4.3-3.3-3 4.4-.5z" fill={tab.starred ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.2"/></svg>
        </button>
        {tab.type !== 'today' && (
          <>
            <button className="icon-btn" onClick={() => setScheduling(true)} aria-label="schedule" title="schedule & location">
              <svg viewBox="0 0 16 16" width="16" height="16"><rect x="2" y="3" width="12" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2"/><path d="M2 6h12M5 1.5v3M11 1.5v3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
            </button>
            <button className="icon-btn" onClick={() => setSharing(true)} aria-label="share" title="share">
              <svg viewBox="0 0 16 16" width="16" height="16"><circle cx="11.5" cy="3.5" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.2"/><circle cx="4.5" cy="7" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.2"/><circle cx="11.5" cy="10.5" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.2"/><path d="M9.9 4.4L6.1 6.2M6.1 7.8l3.8 1.8" stroke="currentColor" strokeWidth="1.2"/></svg>
            </button>
          </>
        )}
      </header>
      {tab.type !== 'today' && <BoardActivity tabId={tab.id} />}
      <div className="tab-view-body">
        <TabEditor tabId={tab.id} autoFocus />
      </div>
      {sharing && <SharePanel tabId={tab.id} tabName={tab.name} onClose={() => setSharing(false)} />}
      {scheduling && <EventsPanel tabId={tab.id} tabName={tab.name} onClose={() => setScheduling(false)} />}
    </main>
  );
}
