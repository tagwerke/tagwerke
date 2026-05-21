import { useStore } from '../store';
import { CardPreview } from '../editor/CardPreview';
import type { ID } from '../types';
import { contrastText, hexToRgba } from '../util/color';

interface Props { tabId: ID; compact?: boolean }

export function TabCard({ tabId, compact }: Props) {
  const tab = useStore((s) => s.tabs[tabId]);
  const project = useStore((s) => (tab ? s.projects[tab.projectId] : undefined));
  const setActiveTab = useStore((s) => s.setActiveTab);
  const setTabStarred = useStore((s) => s.setTabStarred);
  const deleteTab = useStore((s) => s.deleteTab);
  const tasks = useStore((s) => s.tasks);

  if (!tab) return null;
  const taskCount = Object.values(tasks).filter((t) => t.homeTabId === tab.id).length;

  const accent = project?.color ?? '#888';
  const style = {
    '--card-accent': accent,
    '--card-accent-soft': hexToRgba(accent, 0.12),
    '--card-accent-strong': hexToRgba(accent, 0.55),
    '--card-text-on-accent': contrastText(accent),
  } as React.CSSProperties;

  return (
    <article
      className={`tab-card ${compact ? 'compact' : ''}`}
      style={style}
      onClick={() => setActiveTab(tab.id)}
    >
      <header className="tab-card-head">
        <span className="tab-card-project" title={project?.name}>{project?.name}</span>
        <div className="tab-card-actions">
          <button
            className={`icon-btn star ${tab.starred ? 'on' : ''}`}
            onClick={(e) => { e.stopPropagation(); setTabStarred(tab.id, !tab.starred); }}
            aria-label="star tab"
            title={tab.starred ? 'unstar' : 'star'}
          >
            <svg viewBox="0 0 16 16" width="14" height="14"><path d="M8 1.7l1.9 4 4.4.5-3.3 3 .9 4.3L8 11.6l-3.9 1.9.9-4.3-3.3-3 4.4-.5z" fill={tab.starred ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.2"/></svg>
          </button>
          {!compact && (
            <button
              className="icon-btn delete"
              onClick={(e) => { e.stopPropagation(); if (confirm(`Delete "${tab.name}"?`)) deleteTab(tab.id); }}
              aria-label="delete tab"
              title="delete"
            >
              <svg viewBox="0 0 16 16" width="12" height="12"><path d="M4 4l8 8M12 4L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
            </button>
          )}
        </div>
      </header>
      <h3 className="tab-card-title">{tab.name}</h3>
      <div className="tab-card-body">
        <CardPreview tabId={tab.id} />
      </div>
      <footer className="tab-card-foot">
        <span className="tab-card-count">{taskCount} {taskCount === 1 ? 'task' : 'tasks'}</span>
      </footer>
    </article>
  );
}
