// Managing columns from the table itself (CUSTOM_FIELDS_PLAN P4). Board admins only — the server
// refuses everyone else, and the table does not draw these for them.
//
//   AddColumn        the + at the end of the header: a new column is a new field, so it asks for
//                    the field's name and type, and the server adds the field and its column in
//                    one write.
//   FieldColumnMenu  a field column's header menu: rename the field, hide its column, or delete it.
//
// Everything else about columns (the built-ins, the order) is in Board settings → Table. Both
// popovers are fixed to the viewport under the button that opened them, because the table scrolls
// sideways and would clip anything positioned inside it.

import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import { api, type BoardTable } from '../../api/client';
import { useOffline } from '../../offline/status';
import { showToast } from '../../toast/useToast';
import { askConfirm } from '../../confirm/useConfirm';
import { FIELD_TYPE_HINT, FIELD_TYPE_LABEL, fieldRefusal } from '../../tasks/fields';
import { FIELD_TYPES, MAX_FIELDS, fieldColumn, type BoardField, type FieldType } from '../../../shared/fields';
import type { ID } from '../../types';

const POP_WIDTH = 300;

/** A panel under `anchor`; a click outside it or Escape closes it, and says which. */
function Popover({ anchor, label, onClose, children }: {
  anchor: DOMRect;
  label: string;
  onClose: (how: 'outside' | 'escape') => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose('outside'); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose('escape'); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - POP_WIDTH - 8));
  return (
    // Keys stop here: the popover sits inside the table, whose own keys (typing renames a title)
    // must not fire while a name is being typed.
    <div ref={ref} className="col-pop" role="dialog" aria-label={label} style={{ top: anchor.bottom + 4, left, width: POP_WIDTH }} onKeyDown={(e) => e.stopPropagation()}>
      {children}
    </div>
  );
}

/** Run one field or column write and apply what it answers with. False when it didn't happen. */
async function writeTable(tabId: ID, run: () => Promise<BoardTable>): Promise<boolean> {
  if (!useOffline.getState().online) {
    showToast('You’re offline. Columns can only be changed online.');
    return false;
  }
  try {
    const r = await run();
    useStore.getState().setBoardFields(tabId, r.fields, r.columns);
    return true;
  } catch (e) {
    showToast(fieldRefusal(e));
    return false;
  }
}

export function AddColumn({ tabId, fieldCount, anchor, onClose }: {
  tabId: ID;
  fieldCount: number;
  anchor: DOMRect;
  onClose: () => void;
}) {
  const [label, setLabel] = useState('');
  const [type, setType] = useState<FieldType>('text');
  const [busy, setBusy] = useState(false);
  const name = label.trim();

  const submit = async () => {
    if (!name || busy) return;
    setBusy(true);
    const ok = await writeTable(tabId, () => api.fields.create(tabId, { label: name, type, column: true }));
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Popover anchor={anchor} label="Add a column" onClose={onClose}>
      <span className="col-pop-title">New column</span>
      {fieldCount >= MAX_FIELDS ? (
        <p className="col-pop-note">A board can have at most {MAX_FIELDS} fields. Delete one in Board settings → Fields to add another.</p>
      ) : (
        <>
          <label className="col-pop-field">
            <span>Name</span>
            <input
              autoFocus
              value={label}
              maxLength={40}
              placeholder="e.g. Contact email"
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
            />
          </label>
          <div className="col-pop-field" role="radiogroup" aria-label="Type">
            <span>Type</span>
            <div className="col-pop-types">
              {FIELD_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={type === t}
                  className={`col-pop-type ${type === t ? 'is-on' : ''}`}
                  onClick={() => setType(t)}
                >
                  {FIELD_TYPE_LABEL[t]}
                </button>
              ))}
            </div>
            <span className="col-pop-hint">{FIELD_TYPE_LABEL[type]}: {FIELD_TYPE_HINT[type]}</span>
          </div>
          <p className="col-pop-note">Adds this field to every task on the board. Its type can’t be changed later.</p>
          <div className="col-pop-actions">
            <button type="button" className="btn ghost tiny" onClick={onClose}>Cancel</button>
            <button type="button" className="btn tiny primary" disabled={!name || busy} onClick={() => void submit()}>Add column</button>
          </div>
        </>
      )}
    </Popover>
  );
}

export function FieldColumnMenu({ tabId, field, columns, anchor, onClose }: {
  tabId: ID;
  field: BoardField;
  /** The board's column ids, so hiding writes the list without this one. */
  columns: readonly string[];
  anchor: DOMRect;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(field.label);
  const [busy, setBusy] = useState(false);

  const run = async (write: () => Promise<BoardTable>): Promise<boolean> => {
    setBusy(true);
    const ok = await writeTable(tabId, write);
    setBusy(false);
    return ok;
  };

  const commitLabel = () => {
    const next = label.trim();
    if (!next || next === field.label) return setLabel(field.label);
    void run(() => api.fields.update(tabId, field.key, { label: next })).then((ok) => { if (!ok) setLabel(field.label); });
  };

  // Clicking away keeps a typed name, the way leaving the field does; Escape drops it.
  const close = (how: 'outside' | 'escape') => {
    if (how === 'outside') commitLabel();
    onClose();
  };

  const hide = async () => {
    if (await run(() => api.fields.columns(tabId, columns.filter((c) => c !== fieldColumn(field.key))))) onClose();
  };

  const remove = async () => {
    const tasks = useStore.getState().tasks;
    const n = Object.values(tasks).filter((t) => t.homeTabId === tabId && t.fields?.[field.key] != null).length;
    onClose();
    const ok = await askConfirm({
      title: `Delete “${field.label}”?`,
      body: n
        ? `${n} ${n === 1 ? 'task has a value' : 'tasks have values'} in it. They stop showing, and stay in each task’s history.`
        : 'No tasks on this board have a value in it.',
      confirmLabel: 'Delete field',
    });
    if (ok) await writeTable(tabId, () => api.fields.remove(tabId, field.key));
  };

  return (
    <Popover anchor={anchor} label={`${field.label} column`} onClose={close}>
      <label className="col-pop-field">
        <span>Column name</span>
        <input
          value={label}
          maxLength={40}
          disabled={busy}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={commitLabel}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
      </label>
      <span className="col-pop-hint">{FIELD_TYPE_LABEL[field.type]} · the type can’t be changed</span>
      <div className="col-pop-list">
        <button type="button" className="col-pop-item" disabled={busy} onClick={() => void hide()}>Hide column</button>
        <button type="button" className="col-pop-item is-danger" disabled={busy} onClick={() => void remove()}>Delete field…</button>
      </div>
    </Popover>
  );
}
