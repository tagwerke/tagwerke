// App settings › Spaces: every space as an editable row (colour, name, delete), and a last row that
// adds one. This replaces the sidebar's space list and its popover editor — spaces only group your
// own boards, so they belong in settings, not in the nav.
//
// Edits save as you make them (optimistic store action → durable outbox), as the popover did. Spaces
// are per-user rows, not a CRDT, so a plain controlled input is correct.

import { useState } from 'react';
import { useStore } from '../../store';
import { confirmDeleteSpace } from '../../confirm/prompts';
import { Section } from '../common/Section';
import type { Project } from '../../types';

const SPACE_COLORS = ['#ff6a3d', '#f7c948', '#1f8a76', '#7c5cff', '#2d8fce', '#c2603a'];

function Swatches({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  return (
    <div className="space-form-colors">
      {SPACE_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          className={`space-swatch ${c === value ? 'on' : ''}`}
          style={{ background: c }}
          aria-label={`Colour ${c}`}
          aria-pressed={c === value}
          onClick={() => onChange(c)}
        />
      ))}
    </div>
  );
}

function SpaceRow({ project, canDelete }: { project: Project; canDelete: boolean }) {
  const renameProject = useStore((s) => s.renameProject);
  const recolorProject = useStore((s) => s.recolorProject);
  const deleteProject = useStore((s) => s.deleteProject);
  const boardCount = useStore(
    (s) => Object.values(s.tabs).filter((t) => t.projectId === project.id && t.type !== 'today').length,
  );
  // Local, so the field can be empty while typing; an empty name is never sent, and leaving the
  // field empty puts the saved name back.
  const [name, setName] = useState(project.name);

  return (
    <div className="spaces-row">
      <Swatches value={project.color} onChange={(c) => recolorProject(project.id, c)} />
      <input
        className="space-form-name"
        value={name}
        aria-label="Space name"
        onChange={(e) => {
          setName(e.target.value);
          if (e.target.value.trim()) renameProject(project.id, e.target.value);
        }}
        onBlur={() => { if (!name.trim()) setName(project.name); }}
      />
      <span className="count">{boardCount} board{boardCount === 1 ? '' : 's'}</span>
      <button
        type="button"
        className="space-form-action danger"
        disabled={!canDelete}
        title={canDelete ? undefined : 'Keep at least one space'}
        onClick={() => {
          void confirmDeleteSpace(project.name, boardCount).then((ok) => {
            if (ok) deleteProject(project.id);
          });
        }}
      >
        Delete
      </button>
    </div>
  );
}

function NewSpaceRow() {
  const createProject = useStore((s) => s.createProject);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState(SPACE_COLORS[0]);

  const create = () => {
    const n = name.trim();
    if (!n) return;
    createProject(n, color);
    setName('');
    setAdding(false);
  };

  if (!adding) {
    return (
      <button type="button" className="space-add-row" onClick={() => setAdding(true)}>
        <span className="space-add-icon" aria-hidden>+</span>
        <span>New space</span>
      </button>
    );
  }
  return (
    <div className="spaces-row">
      <Swatches value={color} onChange={setColor} />
      <input
        className="space-form-name"
        autoFocus
        value={name}
        placeholder="Space name"
        aria-label="New space name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') create();
          // Claim the Escape: it cancels the new row, not the whole settings modal.
          if (e.key === 'Escape') { e.preventDefault(); setAdding(false); }
        }}
      />
      <button type="button" className="space-form-action" disabled={!name.trim()} onClick={create}>
        Add
      </button>
      <button type="button" className="btn ghost tiny" onClick={() => setAdding(false)}>
        Cancel
      </button>
    </div>
  );
}

export function SpacesSection() {
  const projectOrder = useStore((s) => s.projectOrder);
  const projects = useStore((s) => s.projects);
  const canDelete = projectOrder.length > 1; // never delete the last space

  return (
    <Section title="Spaces" description="Group your boards. Only you see your spaces; filter the boards page by one from its filter strip.">
      <div className="spaces-list">
        {projectOrder.map((id) => {
          const p = projects[id];
          return p ? <SpaceRow key={id} project={p} canDelete={canDelete} /> : null;
        })}
        <NewSpaceRow />
      </div>
    </Section>
  );
}
