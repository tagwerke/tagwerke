// CSV importer wizard. First adapter of a shared import pipeline (SPRINT_PLAN.md Sprint 3) —
// v1 scope: always creates a brand-new board (undo = delete the board), flat task list only.
// No generic Stepper component: this is the only wizard in the app, so local step state is
// enough (matches the ad hoc useState idiom NewTabDialog/SharePanel already use).

import { useMemo, useState } from 'react';
import Papa from 'papaparse';
import { nanoid } from 'nanoid';
import { useStore, nextPosition } from '../store';
import { api } from '../api/client';
import { repull } from '../session/useSession';
import { Sheet } from './common/Sheet';
import { Dropdown, type DropdownOption } from './Dropdown';
import type { TaskStatus } from '../types';
import {
  TITLE_CANDIDATES,
  STATUS_CANDIDATES,
  ASSIGNEE_CANDIDATES,
  PRIORITY_CANDIDATES,
  DATE_CANDIDATES,
  PARENT_CANDIDATES,
  suggestColumn,
  suggestStatus,
  looksLikeEmail,
  parsePriorityRaw,
  parseDateRaw,
  distinctValues,
} from '../util/csvImport';

type Step = 'upload' | 'map' | 'status' | 'preview' | 'result';

interface ColumnMap {
  title: string | null;
  status: string | null;
  assignee: string | null;
  priority: string | null;
  date: string | null;
  /** Names the PARENT task by title (SUBTASKS_PLAN P7) — an exported CSV knows the parent's name,
   *  never Tagwerke's ids, so the cell is matched against the other rows' titles. */
  parent: string | null;
}

const STATUS_OPTIONS: DropdownOption[] = [
  { value: 'todo', label: 'todo' },
  { value: 'in_progress', label: 'in progress' },
  { value: 'in_review', label: 'in review' },
  { value: 'done', label: 'done' },
  { value: 'cancelled', label: 'cancelled' },
];

export function ImportCsvSheet({ onClose }: { onClose: () => void }) {
  const tabs = useStore((s) => s.tabs);
  const projects = useStore((s) => s.projects);
  const projectOrder = useStore((s) => s.projectOrder);
  const createProject = useStore((s) => s.createProject);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const filter = useStore((s) => s.filter);
  const activeSpace = filter.projectIds.length === 1 ? filter.projectIds[0] : null;

  const [step, setStep] = useState<Step>('upload');
  const [dragging, setDragging] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<Record<string, string>[]>([]);
  const [columnMap, setColumnMap] = useState<ColumnMap>({
    title: null, status: null, assignee: null, priority: null, date: null, parent: null,
  });
  const [boardName, setBoardName] = useState('');
  const [projectId, setProjectId] = useState(activeSpace ?? projectOrder[0] ?? '');
  const [newProjectMode, setNewProjectMode] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [statusMap, setStatusMap] = useState<Record<string, TaskStatus>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<{ created: number; matchedAssignees: number; unmatchedAssignees: number } | null>(null);

  const columnOptions: DropdownOption[] = headers.map((h) => ({ value: h, label: h }));
  const optionalColumnOptions: DropdownOption[] = [{ value: '', label: '(none)' }, ...columnOptions];

  const processFile = (file: File) => {
    setParseError(null);
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const fields = results.meta.fields ?? [];
        if (!fields.length || !results.data.length) {
          setParseError('no rows found in that file');
          return;
        }
        setHeaders(fields);
        setRawRows(results.data);
        setColumnMap({
          title: suggestColumn(fields, TITLE_CANDIDATES),
          status: suggestColumn(fields, STATUS_CANDIDATES),
          assignee: suggestColumn(fields, ASSIGNEE_CANDIDATES),
          priority: suggestColumn(fields, PRIORITY_CANDIDATES),
          date: suggestColumn(fields, DATE_CANDIDATES),
          parent: suggestColumn(fields, PARENT_CANDIDATES),
        });
        setBoardName(file.name.replace(/\.csv$/i, ''));
        setStep('map');
      },
      error: (err) => setParseError(err.message),
    });
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
    e.target.value = ''; // allow re-picking the same file name after an error
  };

  const handleDrop = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) processFile(file);
  };

  const goToStatusStep = () => {
    const distinct = distinctValues(rawRows, columnMap.status);
    const next: Record<string, TaskStatus> = {};
    for (const raw of distinct) next[raw] = statusMap[raw] ?? suggestStatus(raw);
    setStatusMap(next);
    setStep('status');
  };

  const normalizedRows = useMemo(() => {
    // First pass: title -> id, so a row may name a parent that appears LATER in the file. A title
    // used twice is ambiguous, so it is dropped from the lookup rather than resolved arbitrarily —
    // silently nesting under whichever duplicate won would be worse than leaving both top-level.
    const idByTitle = new Map<string, string | null>();
    const seed = rawRows.map((row) => {
      const title = (columnMap.title ? row[columnMap.title] : '')?.trim() ?? '';
      if (!title) return null;
      const id = nanoid();
      const key = title.toLowerCase();
      idByTitle.set(key, idByTitle.has(key) ? null : id);
      return { row, title, id };
    });

    return seed
      .map((entry) => {
        if (!entry) return null;
        const { row, title, id } = entry;
        const rawStatus = columnMap.status ? (row[columnMap.status] ?? '').trim() : '';
        const status = statusMap[rawStatus] ?? 'todo';
        const rawAssignee = (columnMap.assignee ? row[columnMap.assignee] : '')?.trim() ?? '';
        const assigneeEmail = looksLikeEmail(rawAssignee) ? rawAssignee : null;
        const rawParent = (columnMap.parent ? row[columnMap.parent] : '')?.trim() ?? '';
        // Never let a row parent ITSELF (a self-referencing cell is a common export artefact).
        const parentId = rawParent ? idByTitle.get(rawParent.toLowerCase()) ?? null : null;
        return {
          id,
          title,
          status,
          parentId: parentId && parentId !== id ? parentId : null,
          assigneeEmail,
          assigneeRaw: rawAssignee || null,
          priority: parsePriorityRaw(columnMap.priority ? row[columnMap.priority] : undefined),
          date: parseDateRaw(columnMap.date ? row[columnMap.date] : undefined),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
  }, [rawRows, columnMap, statusMap]);

  const nestedCount = normalizedRows.filter((r) => r.parentId).length;

  const skipped = rawRows.length - normalizedRows.length;
  // Advisory only — not an authoritative lookup, just "this cell isn't even email-shaped".
  const unmatchedHeuristic = normalizedRows.filter((r) => r.assigneeRaw && !r.assigneeEmail).length;

  const submit = async () => {
    let pid = projectId;
    if (newProjectMode) {
      if (!newProjectName.trim()) return;
      pid = createProject(newProjectName.trim()).id;
    }
    if (!pid || !boardName.trim() || !normalizedRows.length) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const boardId = nanoid();
      const position = nextPosition(Object.values(tabs).map((t) => t.order));
      const res = await api.imports.csv({ boardId, projectId: pid, boardName: boardName.trim(), position, rows: normalizedRows });
      await repull();
      setActiveTab(res.tabId);
      setResult(res);
      setStep('result');
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'import failed — try again');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Sheet title="Import CSV" onClose={onClose}>
      {step === 'upload' && (
        <div>
          <p>Import tasks from a CSV export (Trello, Asana, a spreadsheet, …). Every import creates a new board.</p>
          <label
            className={`file-drop ${dragging ? 'is-dragging' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
          >
            <svg className="file-drop-icon" viewBox="0 0 24 24" width="28" height="28" aria-hidden>
              <path d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M4 15v3a2 2 0 002 2h12a2 2 0 002-2v-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="file-drop-title">Drag a CSV file here, or <em>browse</em></span>
            <span className="file-drop-hint">.csv up to a few thousand rows</span>
            <input type="file" accept=".csv,text/csv" onChange={handleFile} />
          </label>
          {parseError && <div className="share-error">{parseError}</div>}
        </div>
      )}

      {step === 'map' && (
        <div>
          <label className="field">
            <span>board name</span>
            <input value={boardName} onChange={(e) => setBoardName(e.target.value)} placeholder="e.g. Imported from Trello" />
          </label>
          <label className="field">
            <span>space</span>
            {newProjectMode ? (
              <input value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)} placeholder="new space name" />
            ) : (
              <Dropdown
                value={projectId}
                onChange={setProjectId}
                options={projectOrder.map((pid) => ({ value: pid, label: projects[pid]?.name ?? '', accent: projects[pid]?.color }))}
                placeholder="select a space"
              />
            )}
          </label>
          <button className="link-btn" onClick={() => setNewProjectMode((v) => !v)}>
            {newProjectMode ? '← pick existing space' : '+ new space'}
          </button>

          <h3>columns</h3>
          <label className="field">
            <span>title</span>
            <Dropdown value={columnMap.title ?? ''} onChange={(v) => setColumnMap((m) => ({ ...m, title: v }))} options={columnOptions} placeholder="select column" />
          </label>
          <label className="field">
            <span>status</span>
            <Dropdown value={columnMap.status ?? ''} onChange={(v) => setColumnMap((m) => ({ ...m, status: v }))} options={columnOptions} placeholder="select column" />
          </label>
          <label className="field">
            <span>assignee (optional)</span>
            <Dropdown value={columnMap.assignee ?? ''} onChange={(v) => setColumnMap((m) => ({ ...m, assignee: v || null }))} options={optionalColumnOptions} />
          </label>
          <label className="field">
            <span>priority (optional)</span>
            <Dropdown value={columnMap.priority ?? ''} onChange={(v) => setColumnMap((m) => ({ ...m, priority: v || null }))} options={optionalColumnOptions} />
          </label>
          <label className="field">
            <span>due date (optional)</span>
            <Dropdown value={columnMap.date ?? ''} onChange={(v) => setColumnMap((m) => ({ ...m, date: v || null }))} options={optionalColumnOptions} />
          </label>
          <label className="field">
            <span>parent task (optional)</span>
            <Dropdown value={columnMap.parent ?? ''} onChange={(v) => setColumnMap((m) => ({ ...m, parent: v || null }))} options={optionalColumnOptions} />
          </label>

          <div className="modal-actions">
            <button className="btn ghost" onClick={onClose}>cancel</button>
            <button
              className="btn primary"
              disabled={!columnMap.title || !columnMap.status || !boardName.trim() || (!projectId && !newProjectMode)}
              onClick={goToStatusStep}
            >
              next
            </button>
          </div>
        </div>
      )}

      {step === 'status' && (
        <div>
          <p>Map each status value found in the file to one of Tagwerke's statuses.</p>
          {Object.keys(statusMap).map((raw) => (
            <label className="field" key={raw}>
              <span>{raw}</span>
              <Dropdown value={statusMap[raw]} onChange={(v) => setStatusMap((m) => ({ ...m, [raw]: v as TaskStatus }))} options={STATUS_OPTIONS} />
            </label>
          ))}
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setStep('map')}>back</button>
            <button className="btn primary" onClick={() => setStep('preview')}>next</button>
          </div>
        </div>
      )}

      {step === 'preview' && (
        <div>
          <p>{normalizedRows.length} task(s) → 1 new board ("{boardName.trim()}")</p>
          {nestedCount > 0 && <p>{nestedCount} will be nested as sub-tasks.</p>}
          {unmatchedHeuristic > 0 && (
            <p>{unmatchedHeuristic} assignee(s) won't match a real user — kept as a display label instead.</p>
          )}
          {skipped > 0 && <p>{skipped} row(s) skipped (no title).</p>}
          {submitError && <div className="share-error">{submitError}</div>}
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setStep('status')} disabled={submitting}>back</button>
            <button className="btn primary" onClick={submit} disabled={submitting || !normalizedRows.length}>
              {submitting ? 'importing…' : 'create board'}
            </button>
          </div>
        </div>
      )}

      {step === 'result' && result && (
        <div>
          <p>Imported {result.created} task(s).</p>
          {result.matchedAssignees > 0 && <p>{result.matchedAssignees} assignee(s) matched to a real user.</p>}
          {result.unmatchedAssignees > 0 && <p>{result.unmatchedAssignees} assignee(s) didn't match anyone and were kept as a label.</p>}
          <div className="modal-actions">
            <button className="btn primary" onClick={onClose}>done</button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
