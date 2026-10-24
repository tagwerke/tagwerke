// A board's task states (BOARD_STATES_PLAN P4): the list everyone can read — it is where "what does
// Contacted mean here" gets answered — and, for the board's admins, the place to edit it.
//
// Writes are direct API calls, not the offline outbox: this is configuration, the server's rules
// decide (a board must keep a Not started and a Done state, at most 12 states, where the tasks of a
// deleted state go), and every call answers with the whole new list, applied as-is. Offline, the
// controls refuse with a toast instead of queueing something the server may turn down later.

import { useState } from 'react';
import { useStore } from '../../store';
import { api, ApiError } from '../../api/client';
import { useOffline } from '../../offline/status';
import { showToast } from '../../toast/useToast';
import { askConfirm } from '../../confirm/useConfirm';
import { Dropdown, type DropdownOption } from '../Dropdown';
import { stateStyle, useBoardStates } from '../../tasks/states';
import {
  MAX_STATES, REQUIRED_CATEGORIES, STATE_COLORS, STATUS_CATEGORIES, nextSameCategory, visible,
  type BoardState, type StatusCategory,
} from '../../../shared/status';

// The words explain the behavior, so keep them exactly (BOARD_STATES_PLAN P4).
const CATEGORY_TEXT: Record<StatusCategory, { name: string; hint: string }> = {
  open: { name: 'Not started', hint: 'new tasks can start here.' },
  active: { name: 'In progress', hint: 'being worked on.' },
  waiting: { name: 'Waiting', hint: 'stalled on someone or something.' },
  done: { name: 'Done', hint: 'finished; ticks the checkmark.' },
  closed: { name: 'Closed', hint: 'dropped or lost; finished without success.' },
};

const CATEGORY_OPTIONS: DropdownOption[] = STATUS_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_TEXT[c].name, hint: CATEGORY_TEXT[c].hint }));

/** What a refused write means, in a sentence. */
function refusal(e: unknown): string {
  const data = e instanceof ApiError ? e.data : undefined;
  if (data?.error === 'required_category') return `A board needs at least one ${CATEGORY_TEXT[data.category as StatusCategory]?.name ?? ''} state.`;
  if (data?.error === 'label_taken') return 'Another state already has that name.';
  if (data?.error === 'too_many_states') return `A board can have at most ${MAX_STATES} states.`;
  if (e instanceof ApiError && e.status === 403) return 'Only board admins can change task states.';
  return 'Could not save the change.';
}

export function BoardStatesPanel({ tabId }: { tabId: string }) {
  const states = useBoardStates(tabId);
  const isAdmin = useStore((s) => s.tabs[tabId]?.role === 'admin');
  const tasks = useStore((s) => s.tasks);
  const setBoardStates = useStore((s) => s.setBoardStates);
  const online = useOffline((s) => s.online);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ordered = [...states].sort((a, b) => a.position - b.position);
  const countFor = (key: string) => Object.values(tasks).filter((t) => t.homeTabId === tabId && t.status === key).length;
  // The last visible state of a required category can't be hidden, deleted or re-categorized (D2).
  // The controls say so up front; the server's 409 is only the backstop.
  const isLastRequired = (s: BoardState) =>
    REQUIRED_CATEGORIES.includes(s.category) && !s.hidden && visible(states).filter((o) => o.category === s.category).length === 1;

  /** Run one write and apply the list it answers with. False when it didn't happen. */
  async function write(run: () => Promise<{ states: BoardState[] }>): Promise<boolean> {
    if (!online) {
      showToast('You’re offline. Task states can only be changed online.');
      return false;
    }
    setBusy(true);
    try {
      setBoardStates(tabId, (await run()).states);
      return true;
    } catch (e) {
      showToast(refusal(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const move = (key: string, by: -1 | 1) => {
    const keys = ordered.map((s) => s.key);
    const i = keys.indexOf(key);
    const j = i + by;
    if (j < 0 || j >= keys.length) return;
    [keys[i], keys[j]] = [keys[j], keys[i]];
    void write(() => api.states.reorder(tabId, keys));
  };

  return (
    <div className="sprints-page states-panel">
      <p className="sprints-note muted">
        Every state has a category. The category is what the app goes by: the checkmark, the overdue flag and the weekly
        sprint carry-over read it, not the name.
      </p>

      <ul className="sprints-list">
        {ordered.map((s, i) => {
          const n = countFor(s.key);
          const editing = isAdmin && open === s.key;
          return (
            <li key={s.key} className={`sprints-row states-row ${s.hidden ? 'is-hidden' : ''}`}>
              <div className="sprints-row-main">
                <span className="list-dot" style={stateStyle(s)} aria-hidden />
                <span className="sprints-row-label states-row-label" title={s.description ?? undefined}>{s.label}</span>
                {s.hidden && <span className="states-row-tag">hidden</span>}
                <span className="states-row-cat" title={`${CATEGORY_TEXT[s.category].name}: ${CATEGORY_TEXT[s.category].hint}`}>
                  {CATEGORY_TEXT[s.category].name}
                </span>
                <span className="sprints-row-count" title={`${n} task${n === 1 ? '' : 's'}`}>{n}</span>
                {isAdmin && (
                  <>
                    <button type="button" className="sprints-row-more" disabled={busy || i === 0} aria-label={`Move ${s.label} up`} onClick={() => move(s.key, -1)}>
                      <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden><path d="M2 8l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    </button>
                    <button type="button" className="sprints-row-more" disabled={busy || i === ordered.length - 1} aria-label={`Move ${s.label} down`} onClick={() => move(s.key, 1)}>
                      <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    </button>
                    <button
                      type="button"
                      className={`sprints-row-more ${editing ? 'is-open' : ''}`}
                      aria-label={`Edit ${s.label}`}
                      aria-expanded={editing}
                      onClick={() => setOpen(editing ? null : s.key)}
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
              {s.description && !editing && <p className="states-row-desc">{s.description}</p>}
              {editing && (
                <StateEditor
                  key={s.key}
                  tabId={tabId}
                  state={s}
                  states={states}
                  taskCount={n}
                  locked={isLastRequired(s)}
                  busy={busy}
                  write={write}
                  onDeleted={() => setOpen(null)}
                />
              )}
            </li>
          );
        })}
      </ul>

      {isAdmin && <AddState tabId={tabId} full={states.length >= MAX_STATES} busy={busy} write={write} />}
    </div>
  );
}

type Write = (run: () => Promise<{ states: BoardState[] }>) => Promise<boolean>;

function StateEditor({ tabId, state, states, taskCount, locked, busy, write, onDeleted }: {
  tabId: string;
  state: BoardState;
  states: readonly BoardState[];
  taskCount: number;
  /** The last visible state of a required category. */
  locked: boolean;
  busy: boolean;
  write: Write;
  onDeleted: () => void;
}) {
  const [label, setLabel] = useState(state.label);
  const [description, setDescription] = useState(state.description ?? '');
  // The delete flow, once it needs a decision: how many tasks use the state, and where they go.
  const [deleting, setDeleting] = useState<{ count: number; choice: 'move' | 'hide'; moveTo: string } | null>(null);
  const update = (b: Parameters<typeof api.states.update>[2]) => write(() => api.states.update(tabId, state.key, b));
  const requiredName = CATEGORY_TEXT[state.category].name;

  const commitLabel = () => {
    const next = label.trim();
    if (!next || next === state.label) return setLabel(state.label);
    void update({ label: next }).then((ok) => { if (!ok) setLabel(state.label); });
  };
  const commitDescription = () => {
    const next = description.trim();
    if (next === (state.description ?? '')) return;
    void update({ description: next || null });
  };

  const targets = visible(states).filter((s) => s.key !== state.key);
  const askWhere = (count: number) =>
    setDeleting({ count, choice: 'move', moveTo: nextSameCategory(states, state.key) });

  async function startDelete() {
    if (taskCount > 0) return askWhere(taskCount);
    const ok = await askConfirm({
      title: `Delete “${state.label}”?`,
      body: 'No tasks on this board use it.',
      confirmLabel: 'Delete state',
    });
    if (!ok) return;
    try {
      // Straight to the API: a trashed task can still use the state, which only the server sees.
      const r = await api.states.remove(tabId, state.key);
      useStore.getState().setBoardStates(tabId, r.states);
      onDeleted();
    } catch (e) {
      if (e instanceof ApiError && e.data?.error === 'move_required') askWhere(Number(e.data.count) || 1);
      else showToast(refusal(e));
    }
  }

  async function finishDelete() {
    if (!deleting) return;
    const ok = deleting.choice === 'hide'
      ? await update({ hidden: true })
      : await write(() => api.states.remove(tabId, state.key, deleting.moveTo));
    if (!ok) return;
    setDeleting(null);
    if (deleting.choice === 'move') onDeleted();
  }

  if (deleting) {
    const n = deleting.count;
    return (
      <div className="states-editor">
        <p className="states-editor-q">
          {n} {n === 1 ? 'task uses' : 'tasks use'} <em>{state.label}</em>.
        </p>
        <label className="states-editor-choice">
          <input type="radio" checked={deleting.choice === 'move'} onChange={() => setDeleting({ ...deleting, choice: 'move' })} />
          <span className="states-editor-choice-body">
            Move them to
            <Dropdown
              value={deleting.moveTo}
              onChange={(v) => setDeleting({ ...deleting, choice: 'move', moveTo: v })}
              options={targets.map((s) => ({ value: s.key, label: s.label, accent: `var(--state-${s.color})` }))}
            />
          </span>
        </label>
        <label className="states-editor-choice">
          <input type="radio" checked={deleting.choice === 'hide'} disabled={locked} onChange={() => setDeleting({ ...deleting, choice: 'hide' })} />
          <span className="states-editor-choice-body">
            Hide it instead
            <span className="states-editor-note">Its tasks keep it, and nothing new can be set to it.</span>
          </span>
        </label>
        <div className="sprints-row-actions states-editor-actions">
          <button type="button" className="btn tiny danger" disabled={busy} onClick={() => void finishDelete()}>
            {deleting.choice === 'hide' ? 'Hide state' : 'Delete state'}
          </button>
          <button type="button" className="btn ghost tiny" onClick={() => setDeleting(null)}>Cancel</button>
        </div>
      </div>
    );
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
            if (e.key === 'Escape') setLabel(state.label);
          }}
        />
      </label>
      <label className="states-editor-field">
        <span>Description</span>
        <input
          value={description}
          maxLength={200}
          placeholder="One line: what this state means here"
          disabled={busy}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={commitDescription}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        />
      </label>
      <div className="states-editor-field">
        <span>Category</span>
        <Dropdown
          value={state.category}
          options={CATEGORY_OPTIONS}
          disabled={busy || locked}
          onChange={(v) => { if (v !== state.category) void update({ category: v as StatusCategory }); }}
        />
        {locked && <span className="states-editor-note">A board needs at least one {requiredName} state.</span>}
      </div>
      <div className="states-editor-field">
        <span>Color</span>
        <div className="states-palette" role="radiogroup" aria-label="Color">
          {STATE_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={state.color === c}
              aria-label={c}
              title={c}
              disabled={busy}
              className={`states-swatch ${state.color === c ? 'is-selected' : ''}`}
              style={stateStyle({ color: c })}
              onClick={() => { if (c !== state.color) void update({ color: c }); }}
            />
          ))}
        </div>
      </div>
      <div className="sprints-row-actions states-editor-actions">
        <button
          type="button"
          className="btn ghost tiny"
          disabled={busy || (locked && !state.hidden)}
          title={locked ? `A board needs at least one ${requiredName} state.` : undefined}
          onClick={() => void update({ hidden: !state.hidden })}
        >
          {state.hidden ? 'Show in pickers' : 'Hide'}
        </button>
        <button
          type="button"
          className="btn ghost tiny sprints-row-delete"
          disabled={busy || locked}
          title={locked ? `A board needs at least one ${requiredName} state.` : undefined}
          onClick={() => void startDelete()}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function AddState({ tabId, full, busy, write }: { tabId: string; full: boolean; busy: boolean; write: Write }) {
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [category, setCategory] = useState<StatusCategory>('active');

  if (full) return <p className="sprints-note muted">A board can have at most {MAX_STATES} states.</p>;
  if (!adding) {
    return (
      <button type="button" className="btn ghost tiny states-add" onClick={() => setAdding(true)}>
        Add a state
      </button>
    );
  }
  const submit = async () => {
    const name = label.trim();
    if (!name) return;
    if (await write(() => api.states.create(tabId, { label: name, category }))) {
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
        <span>Category</span>
        <Dropdown value={category} options={CATEGORY_OPTIONS} onChange={(v) => setCategory(v as StatusCategory)} />
      </div>
      <div className="sprints-row-actions states-editor-actions">
        <button type="button" className="btn tiny primary" disabled={busy || !label.trim()} onClick={() => void submit()}>Add state</button>
        <button type="button" className="btn ghost tiny" onClick={() => setAdding(false)}>Cancel</button>
      </div>
    </div>
  );
}
