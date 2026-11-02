// Board settings → Table (CUSTOM_FIELDS_PLAN P4): which columns the board's table shows, and in what
// order, the same for everyone on the board. Everyone can read it; admins change it. A field shows
// here once it exists; a column added from the table's + is a field already shown.
//
// Direct API calls, not the offline outbox, for the same reasons as the fields and states panels:
// it is configuration, and every write answers with the whole new list.

import { useState } from 'react';
import { useStore } from '../../store';
import { api } from '../../api/client';
import { useOffline } from '../../offline/status';
import { showToast } from '../../toast/useToast';
import { FIELD_TYPE_LABEL, fieldRefusal, useBoardFields } from '../../tasks/fields';
import { BUILTIN_COLUMN_LABEL } from '../board/workColumns';
import { BUILTIN_COLUMNS, columnFieldKey, fieldColumn, type BuiltinColumn } from '../../../shared/fields';

const NONE: string[] = [];

export function BoardTablePanel({ tabId }: { tabId: string }) {
  const fields = useBoardFields(tabId);
  const ids = useStore((s) => s.tabs[tabId]?.tableColumns) ?? NONE;
  const isAdmin = useStore((s) => s.tabs[tabId]?.role === 'admin');
  const setBoardFields = useStore((s) => s.setBoardFields);
  const online = useOffline((s) => s.online);
  const [busy, setBusy] = useState(false);

  const describe = (id: string): { label: string; kind: string } => {
    const key = columnFieldKey(id);
    if (key === null) return { label: BUILTIN_COLUMN_LABEL[id as BuiltinColumn], kind: 'Built in' };
    const f = fields.find((x) => x.key === key)!;
    return { label: f.label, kind: `Field · ${FIELD_TYPE_LABEL[f.type]}` };
  };
  const hidden = [
    ...BUILTIN_COLUMNS.filter((b) => !ids.includes(b)),
    ...fields.map((f) => fieldColumn(f.key)).filter((c) => !ids.includes(c)),
  ];

  async function write(next: string[]) {
    if (!online) return showToast('You’re offline. Columns can only be changed online.');
    setBusy(true);
    try {
      const r = await api.fields.columns(tabId, next);
      setBoardFields(tabId, r.fields, r.columns);
    } catch (e) {
      showToast(fieldRefusal(e));
    } finally {
      setBusy(false);
    }
  }

  const move = (i: number, by: -1 | 1) => {
    const next = [...ids];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    void write(next);
  };

  const row = (id: string, shown: boolean, i: number) => {
    const { label, kind } = describe(id);
    return (
      <li key={id} className={`sprints-row states-row ${shown ? '' : 'is-hidden'}`}>
        <div className="sprints-row-main">
          <span className="sprints-row-label states-row-label">{label}</span>
          <span className="states-row-cat">{kind}</span>
          {isAdmin && shown && (
            <>
              <button type="button" className="sprints-row-more" disabled={busy || i === 0} aria-label={`Move ${label} left`} onClick={() => move(i, -1)}>
                <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden><path d="M2 8l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
              <button type="button" className="sprints-row-more" disabled={busy || i === ids.length - 1} aria-label={`Move ${label} right`} onClick={() => move(i, 1)}>
                <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
            </>
          )}
          {isAdmin ? (
            <button
              type="button"
              role="switch"
              aria-checked={shown}
              aria-label={`Show ${label}`}
              className="col-switch"
              disabled={busy}
              onClick={() => void write(shown ? ids.filter((c) => c !== id) : [...ids, id])}
            />
          ) : (
            <span className="states-row-tag">{shown ? 'shown' : 'hidden'}</span>
          )}
        </div>
      </li>
    );
  };

  return (
    <div className="sprints-page states-panel">
      <p className="sprints-note muted">
        Which columns this board’s table shows, left to right. Everyone on the board sees the same columns. Hiding a
        column keeps its values; a field’s column can also be added, renamed or hidden from the table’s header.
      </p>
      <ul className="sprints-list">
        <li className="sprints-row states-row">
          <div className="sprints-row-main">
            <span className="sprints-row-label states-row-label">Title</span>
            <span className="states-row-cat">Built in</span>
            <span className="states-row-tag">always shown</span>
          </div>
        </li>
        {ids.map((id, i) => row(id, true, i))}
        {hidden.map((id, i) => row(id, false, i))}
      </ul>
    </div>
  );
}
