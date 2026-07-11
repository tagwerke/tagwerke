import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import type { Project } from '../../types';

// Palette shared by space create + edit (previously duplicated inline in the Sidebar menu).
const SPACE_COLORS = ['#ff6a3d', '#f7c948', '#1f8a76', '#7c5cff', '#2d8fce', '#c2603a'];

interface Props {
  mode: 'create' | 'edit';
  project?: Project; // required in `edit` mode
  onClose: () => void;
  onCreated?: (id: string) => void; // fired after a successful create (e.g. to scope to it)
}

/**
 * Inline space editor popover — ONE form for both creating and editing a space, replacing the old
 * window.prompt/confirm flow. In `edit` mode the name + colour auto-persist as you change them
 * (optimistic store action → durable outbox; spaces are per-user entities, not a CRDT — so a plain
 * controlled input is correct, no co-editing). In `create` mode the values stay local until
 * "Create". Closes on outside click or Escape.
 */
export function SpaceForm({ mode, project, onClose, onCreated }: Props) {
  const createProject = useStore((s) => s.createProject);
  const renameProject = useStore((s) => s.renameProject);
  const recolorProject = useStore((s) => s.recolorProject);
  const deleteProject = useStore((s) => s.deleteProject);
  const canDelete = useStore((s) => s.projectOrder.length > 1); // never delete the last space

  const [name, setName] = useState(project?.name ?? '');
  const [color, setColor] = useState(project?.color ?? SPACE_COLORS[0]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const changeName = (v: string) => {
    setName(v);
    if (mode === 'edit' && project) renameProject(project.id, v); // auto-update
  };
  const changeColor = (c: string) => {
    setColor(c);
    if (mode === 'edit' && project) recolorProject(project.id, c); // auto-update
  };
  const create = () => {
    const n = name.trim();
    if (!n) return;
    const p = createProject(n, color);
    onCreated?.(p.id);
    onClose();
  };

  return (
    <div className="space-form" ref={ref}>
      <input
        className="space-form-name"
        autoFocus
        value={name}
        placeholder="Space name"
        onChange={(e) => changeName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && mode === 'create') create();
        }}
      />
      <div className="space-form-colors">
        {SPACE_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className={`space-swatch ${c === color ? 'on' : ''}`}
            style={{ background: c }}
            aria-label={`Colour ${c}`}
            onClick={() => changeColor(c)}
          />
        ))}
      </div>
      {mode === 'edit' ? (
        <button
          type="button"
          className="space-form-action danger"
          disabled={!canDelete}
          title={canDelete ? undefined : 'Keep at least one space'}
          onClick={() => {
            if (!canDelete) return;
            if (confirmDelete) {
              deleteProject(project!.id);
              onClose();
            } else {
              setConfirmDelete(true);
            }
          }}
        >
          {confirmDelete ? 'Click again to delete' : 'Delete space'}
        </button>
      ) : (
        <button type="button" className="space-form-action" disabled={!name.trim()} onClick={create}>
          Create space
        </button>
      )}
    </div>
  );
}
