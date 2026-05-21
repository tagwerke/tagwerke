import { useEffect } from 'react';
import { useStore } from '../store';
import { TabEditor } from '../editor/Editor';
import { hexToRgba } from '../util/color';

export function TabView({ tabId }: { tabId: string }) {
  const tab = useStore((s) => s.tabs[tabId]);
  const project = useStore((s) => (tab ? s.projects[tab.projectId] : undefined));
  const setActiveTab = useStore((s) => s.setActiveTab);
  const renameTab = useStore((s) => s.renameTab);
  const setTabStarred = useStore((s) => s.setTabStarred);

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
      </header>
      <div className="tab-view-body">
        <TabEditor tabId={tab.id} autoFocus />
      </div>
    </main>
  );
}
