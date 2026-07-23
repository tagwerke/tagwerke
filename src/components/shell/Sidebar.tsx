// The persistent left rail (Shell D): brand + Spaces + the day agenda + account. "Spaces" are
// today's per-user categories (projects) — clicking one scopes the board grid to it via the
// existing filter; the shared-team-space migration comes later. `+` creates a space; the gear
// renames / recolors / deletes it (reusing the existing project store actions).

import { useState } from 'react';
import { useStore } from '../../store';
import { useSession } from '../../session/useSession';
import { Avatar } from '../common/Avatar';
import { AgendaRail } from './AgendaRail';
import { SpaceForm } from './SpaceForm';
import { ProfileDrawer } from './ProfileDrawer';
import type { Project } from '../../types';
import type { Panel } from '../../App';

export function Sidebar({ onOpen }: { onOpen: (panel: Panel) => void }) {
  const projectOrder = useStore((s) => s.projectOrder);
  const projects = useStore((s) => s.projects);
  const filter = useStore((s) => s.filter);
  const setFilter = useStore((s) => s.setFilter);
  const resetFilter = useStore((s) => s.resetFilter);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const me = useSession((s) => s.user);

  const [creating, setCreating] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

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
          <div className="space-add-wrap">
            <button className="space-add-row" onClick={() => setCreating((v) => !v)}>
              <span className="space-add-icon" aria-hidden>+</span>
              <span>New space</span>
            </button>
            {creating && (
              <SpaceForm mode="create" onClose={() => setCreating(false)} onCreated={(id) => selectSpace(id)} />
            )}
          </div>
        </div>
      </div>

      <div className="sidebar-sec">
        <AgendaRail />
      </div>

      <div className="sidebar-spacer" />

      {me && (
        <div className="sidebar-account-wrap">
          <button
            className="sidebar-account"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => setProfileOpen((v) => !v)}
          >
            <Avatar name={me.email} size={26} />
            <span className="sidebar-account-email">{me.email.split('@')[0]}</span>
          </button>
          {profileOpen && (
            <ProfileDrawer email={me.email} onOpen={onOpen} onClose={() => setProfileOpen(false)} />
          )}
        </div>
      )}
    </aside>
  );
}

function SpaceItem({ project, active, onSelect }: { project: Project; active: boolean; onSelect: () => void }) {
  const [editing, setEditing] = useState(false);
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
      <button
        className="space-gear"
        title="Space settings"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => setEditing((v) => !v)}
      >
        ⚙
      </button>
      {editing && <SpaceForm mode="edit" project={project} onClose={() => setEditing(false)} />}
    </div>
  );
}
