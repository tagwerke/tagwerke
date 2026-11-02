// A board's custom fields (CUSTOM_FIELDS_PLAN P2.3): the list everyone can read and, for the board's
// admins, the place to edit it. Built from the states panel's parts, because it is the same kind of
// thing: a per-board list of definitions with a fixed key and an editable name.
//
// Writes are direct API calls, not the offline outbox, for the states panel's reasons: this is
// configuration, the server's rules decide, and every call answers with the whole new list.

import { useState } from 'react';
import { useStore } from '../../store';
import { api, ApiError } from '../../api/client';
import { useOffline } from '../../offline/status';
import { showToast } from '../../toast/useToast';
import { askConfirm } from '../../confirm/useConfirm';
import { Dropdown, type DropdownOption } from '../Dropdown';
import { FIELD_TYPE_LABEL, useBoardFields } from '../../tasks/fields';
import { FIELD_TYPES, MAX_FIELDS, type BoardField, type FieldType } from '../../../shared/fields';

const TYPE_HINT: Record<FieldType, string> = {
  url: 'a web address; shows as a link.',
  email: 'an email address; opens your mail app.',
  phone: 'a phone number; tap to call.',
  number: 'a number, like a score or an amount.',
  text: 'a short line of text.',
};

const TYPE_OPTIONS: DropdownOption[] = FIELD_TYPES.map((t) => ({ value: t, label: FIELD_TYPE_LABEL[t], hint: TYPE_HINT[t] }));

/** What a refused write means, in a sentence. */
function refusal(e: unknown): string {
  const data = e instanceof ApiError ? e.data : undefined;
  if (data?.error === 'label_taken') return 'Another field already has that name.';
  if (data?.error === 'too_many_fields') return `A board can have at most ${MAX_FIELDS} fields.`;
  if (e instanceof ApiError && e.status === 403) return 'Only board admins can change fields.';
  return 'Could not save the change.';
}

export function BoardFieldsPanel({ tabId }: { tabId: string }) {
  const fields = useBoardFields(tabId);
  const isAdmin = useStore((s) => s.tabs[tabId]?.role === 'admin');
  const tasks = useStore((s) => s.tasks);
  const setBoardFields = useStore((s) => s.setBoardFields);
  const online = useOffline((s) => s.online);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ordered = [...fields].sort((a, b) => a.position - b.position);
  const countFor = (key: string) => Object.values(tasks).filter((t) => t.homeTabId === tabId && t.fields?.[key] != null).length;

  /** Run one write and apply the list it answers with. False when it didn't happen. */
  async function write(run: () => Promise<{ fields: BoardField[] }>): Promise<boolean> {
    if (!online) {
      showToast('You’re offline. Fields can only be changed online.');
      return false;
    }
    setBusy(true);
    try {
      setBoardFields(tabId, (await run()).fields);
      return true;
    } catch (e) {
      showToast(refusal(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const move = (key: string, by: -1 | 1) => {
    const keys = ordered.map((f) => f.key);
    const i = keys.indexOf(key);
    const j = i + by;
    if (j < 0 || j >= keys.length) return;
    [keys[i], keys[j]] = [keys[j], keys[i]];
    void write(() => api.fields.reorder(tabId, keys));
  };

  return (
    <div className="sprints-page states-panel">
      <p className="sprints-note muted">
        Fields hold what a task needs beyond its title: a link, an email, a phone number, a score. They show on every
        task’s page. A field’s type can’t change later; make a new field instead.
      </p>

      {ordered.length > 0 && (
        <ul className="sprints-list">
          {ordered.map((f, i) => {
            const n = countFor(f.key);
            const editing = isAdmin && open === f.key;
            return (
              <li key={f.key} className={`sprints-row states-row ${f.hidden ? 'is-hidden' : ''}`}>
                <div className="sprints-row-main">
                  <span className="sprints-row-label states-row-label" title={`Key: ${f.key}`}>{f.label}</span>
                  {f.hidden && <span className="states-row-tag">hidden</span>}
                  <span className="states-row-cat" title={`${FIELD_TYPE_LABEL[f.type]}: ${TYPE_HINT[f.type]}`}>{FIELD_TYPE_LABEL[f.type]}</span>
                  <span className="sprints-row-count" title={`${n} task${n === 1 ? '' : 's'} with a value`}>{n}</span>
                  {isAdmin && (
                    <>
                      <button type="button" className="sprints-row-more" disabled={busy || i === 0} aria-label={`Move ${f.label} up`} onClick={() => move(f.key, -1)}>
                        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden><path d="M2 8l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                      </button>
                      <button type="button" className="sprints-row-more" disabled={busy || i === ordered.length - 1} aria-label={`Move ${f.label} down`} onClick={() => move(f.key, 1)}>
                        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                      </button>
                      <button
                        type="button"
                        className={`sprints-row-more ${editing ? 'is-open' : ''}`}
                        aria-label={`Edit ${f.label}`}
                        aria-expanded={editing}
                        onClick={() => setOpen(editing ? null : f.key)}
                      >
                        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
                          <circle cx="3.5" cy="8" r="1.3" fill="currentColor" />
                          <circle cx="8" cy="8" r="1.3" fill="currentColor" />
                          <circle cx="12.5" cy="8" r="1.3" fill="currentColor" />
                        </svg>
                      </button>
                    </>
                  )}
                </div>
                {editing && (
                  <FieldEditor key={f.key} tabId={tabId} field={f} taskCount={n} busy={busy} write={write} onDeleted={() => setOpen(null)} />
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!ordered.length && !isAdmin && <p className="sprints-note muted">This board has no fields.</p>}
      {isAdmin && <AddField tabId={tabId} full={fields.length >= MAX_FIELDS} busy={busy} write={write} />}
    </div>
  );
}

type Write = (run: () => Promise<{ fields: BoardField[] }>) => Promise<boolean>;

function FieldEditor({ tabId, field, taskCount, busy, write, onDeleted }: {
  tabId: string;
  field: BoardField;
  taskCount: number;
  busy: boolean;
  write: Write;
  onDeleted: () => void;
}) {
  const [label, setLabel] = useState(field.label);
  const update = (b: Parameters<typeof api.fields.update>[2]) => write(() => api.fields.update(tabId, field.key, b));

  const commitLabel = () => {
    const next = label.trim();
    if (!next || next === field.label) return setLabel(field.label);
    void update({ label: next }).then((ok) => { if (!ok) setLabel(field.label); });
  };

  async function remove() {
    const ok = await askConfirm({
      title: `Delete “${field.label}”?`,
      body: taskCount
        ? `${taskCount} ${taskCount === 1 ? 'task has a value' : 'tasks have values'} in it. They stop showing, and stay in each task’s history.`
        : 'No tasks on this board have a value in it.',
      confirmLabel: 'Delete field',
    });
    if (ok && (await write(() => api.fields.remove(tabId, field.key)))) onDeleted();
  }

  return (
    <div className="states-editor">
      <label className="states-editor-field">
        <span>Name</span>
        <input
          value={label}
          maxLength={40}
          disabled={busy}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={commitLabel}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') setLabel(field.label);
          }}
        />
      </label>
      <div className="states-editor-field">
        <span>Type</span>
        <span className="states-editor-note">{FIELD_TYPE_LABEL[field.type]} — {TYPE_HINT[field.type]}</span>
      </div>
      <div className="sprints-row-actions states-editor-actions">
        <button type="button" className="btn ghost tiny" disabled={busy} onClick={() => void update({ hidden: !field.hidden })}>
          {field.hidden ? 'Show on tasks' : 'Hide'}
        </button>
        <button type="button" className="btn ghost tiny sprints-row-delete" disabled={busy} onClick={() => void remove()}>
          Delete
        </button>
      </div>
    </div>
  );
}

function AddField({ tabId, full, busy, write }: { tabId: string; full: boolean; busy: boolean; write: Write }) {
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [type, setType] = useState<FieldType>('text');

  if (full) return <p className="sprints-note muted">A board can have at most {MAX_FIELDS} fields.</p>;
  if (!adding) {
    return (
      <button type="button" className="btn ghost tiny states-add" onClick={() => setAdding(true)}>
        Add a field
      </button>
    );
  }
  const submit = async () => {
    const name = label.trim();
    if (!name) return;
    if (await write(() => api.fields.create(tabId, { label: name, type }))) {
      setLabel('');
      setAdding(false);
    }
  };
  return (
    <div className="states-editor">
      <label className="states-editor-field">
        <span>Name</span>
        <input
          autoFocus
          value={label}
          maxLength={40}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
            if (e.key === 'Escape') setAdding(false);
          }}
        />
      </label>
      <div className="states-editor-field">
        <span>Type</span>
        <Dropdown value={type} options={TYPE_OPTIONS} onChange={(v) => setType(v as FieldType)} />
      </div>
      <div className="sprints-row-actions states-editor-actions">
        <button type="button" className="btn tiny primary" disabled={busy || !label.trim()} onClick={() => void submit()}>Add field</button>
        <button type="button" className="btn ghost tiny" onClick={() => setAdding(false)}>Cancel</button>
      </div>
    </div>
  );
}
