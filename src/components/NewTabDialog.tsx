import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { Dropdown } from './Dropdown';

export function NewTabDialog({ onClose }: { onClose: () => void }) {
  const projects = useStore((s) => s.projects);
  const projectOrder = useStore((s) => s.projectOrder);
  const createTab = useStore((s) => s.createTab);
  const createProject = useStore((s) => s.createProject);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const filter = useStore((s) => s.filter);

  // If the grid is scoped to a single space, preselect it — a new board created from inside a
  // space almost always belongs to that space. Otherwise fall back to the first project.
  const activeSpace = filter.projectIds.length === 1 ? filter.projectIds[0] : null;

  const [name, setName] = useState('');
  const [projectId, setProjectId] = useState(activeSpace ?? projectOrder[0] ?? '');
  const [newProjectMode, setNewProjectMode] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = () => {
    let pid = projectId;
    if (newProjectMode) {
      if (!newProjectName.trim()) return;
      pid = createProject(newProjectName.trim()).id;
    }
    if (!name.trim() || !pid) return;
    const tab = createTab(pid, name.trim());
    setActiveTab(tab.id);
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>new tab</h2>
        <label className="field">
          <span>name</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="e.g. Q2 launch"
          />
        </label>
        <label className="field">
          <span>project</span>
          {newProjectMode ? (
            <input
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              placeholder="new project name"
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          ) : (
            <Dropdown
              value={projectId}
              onChange={setProjectId}
              options={projectOrder.map((pid) => ({
                value: pid,
                label: projects[pid]?.name ?? '',
                accent: projects[pid]?.color,
              }))}
              placeholder="select a project"
            />
          )}
        </label>
        <button className="link-btn" onClick={() => setNewProjectMode((v) => !v)}>
          {newProjectMode ? '← pick existing project' : '+ new project'}
        </button>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>cancel</button>
          <button className="btn primary" onClick={submit}>create</button>
        </div>
      </div>
    </div>
  );
}
