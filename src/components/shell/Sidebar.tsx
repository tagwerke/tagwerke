// The persistent left rail (Shell D): brand + Spaces + the day agenda + account. "Spaces" are
// today's per-user categories (projects) — clicking one scopes the board grid to it via the
// existing filter; the shared-team-space migration comes later. `+` creates a space; the gear
// renames / recolors / deletes it (reusing the existing project store actions).

import { useState } from 'react';
import { useStore } from '../../store';
import { useSession } from '../../session/useSession';
import { Avatar } from '../common/Avatar';
import { AgendaRail } from './AgendaRail';
import type { Project } from '../../types';

const SPACE_COLORS = ['#ff6a3d', '#f7c948', '#1f8a76', '#7c5cff', '#2d8fce', '#c2603a'];

export function Sidebar() {
  const projectOrder = useStore((s) => s.projectOrder);
  const projects = useStore((s) => s.projects);
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);
  const resetFilter = useStore((s) => s.resetFilter);
  const createProject = useStore((s) => s.createProject);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const me = useSession((s) => s.user);

  const activeSpace = filter.projectIds.length === 1 ? filter.projectIds[0] : null;

  const selectSpace = (id: string | null) => {
    setActiveTab(null); // scoping a space returns to the grid
    setFilter({ projectIds: id ? [id] : [] });
  };

  return (
    <aside className="sidebar">
      <button className="brand sidebar-brand" onClick={() => { setActiveTab(null); resetFilter(); }} aria-label="Home">
        <span className="brand-mark" />
        <span className="brand-name">Tagwerke</span>
      </button>

      <div className="sidebar-sec">
        <div className="sidebar-sec-head">
          <span className="sidebar-sec-label">Spaces</span>
          <button
            className="sidebar-add"
            title="New space"
            onClick={() => {
              const name = window.prompt('Space name')?.trim();
              if (name) createProject(name);
            }}
          >
            +
          </button>
        </div>
        <div className="space-list">
          <div className={`space ${!activeSpace ? 'on' : ''}`}>
            <button className="space-main" onClick={() => selectSpace(null)}>
              <span className="space-dot" style={{ background: 'var(--ink-mute)' }} />
              <span className="space-name">All boards</span>
            </button>
          </div>
          {projectOrder.map((id) => {
            const p = projects[id];
            if (!p) return null;
            return <SpaceItem key={id} project={p} active={activeSpace === id} onSelect={() => selectSpace(id)} />;
          })}
        </div>
      </div>

      <div className="sidebar-sec">
        <AgendaRail />
      </div>

      <div className="sidebar-spacer" />

      {me && (
        <div className="sidebar-account">
          <Avatar name={me.email} size={26} />
          <span className="sidebar-account-email">{me.email.split('@')[0]}</span>
        </div>
      )}
    </aside>
  );
}

function SpaceItem({ project, active, onSelect }: { project: Project; active: boolean; onSelect: () => void }) {
  const [menu, setMenu] = useState(false);
  const renameProject = useStore((s) => s.renameProject);
  const recolorProject = useStore((s) => s.recolorProject);
  const deleteProject = useStore((s) => s.deleteProject);
  const count = useStore(
    (s) => Object.values(s.tabs).filter((t) => t.projectId === project.id && t.type !== 'today').length,
  );

  return (
    <div className={`space ${active ? 'on' : ''}`}>
      <button className="space-main" onClick={onSelect}>
        <span className="space-dot" style={{ background: project.color }} />
        <span className="space-name">{project.name}</span>
      </button>
      <span className="space-count">{count}</span>
      <button className="space-gear" title="Space settings" onClick={() => setMenu((v) => !v)}>⚙</button>
      {menu && (
        <div className="space-menu" onMouseLeave={() => setMenu(false)}>
          <button
            onClick={() => {
              const n = window.prompt('Rename space', project.name)?.trim();
              if (n) renameProject(project.id, n);
              setMenu(false);
            }}
          >
            Rename
          </button>
          <div className="space-colors">
            {SPACE_COLORS.map((c) => (
              <button key={c} style={{ background: c }} title={c} onClick={() => { recolorProject(project.id, c); setMenu(false); }} />
            ))}
          </div>
          <button
            className="danger"
            onClick={() => {
              if (window.confirm(`Delete “${project.name}” and its boards?`)) deleteProject(project.id);
              setMenu(false);
            }}
          >
            Delete space
          </button>
        </div>
      )}
    </div>
  );
}
