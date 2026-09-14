// The attachment strip (CONTRACT_TO_PROJECT_PLAN §5a, rung 1) — the list of files attached to a
// board, on the two surfaces that show it: a task page (compact, filtered to that task) and the
// board's Files view (roomier, the whole board).
//
// ONE component, two variants, because they are the same list with the same rules about who may
// upload and what the file's extraction state is allowed to hide. Two components would be two
// places for that honesty to drift apart, and the extraction state is precisely the thing a second
// implementation would quietly leave out.
//
// Upload is DIRECT and NON-OPTIMISTIC (DOCUMENTS_PLAN D1). Every other write in this app goes
// through the durable outbox and pretends to have succeeded; this one does not, and must not. The
// outbox is a JSON queue in IndexedDB — a file would have to be base64'd into it — and, more to
// the point, "your contract is uploaded" is not a claim to make before the bytes have landed. So
// an upload in flight is its own row with a real progress bar, and a failed one stays on screen,
// in place, with what went wrong and a Retry. It is the one write allowed to say "not yet".

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { api } from '../../api/client';
import { askConfirm } from '../../confirm/useConfirm';
import { timeAgo } from '../../util/dates';
import { UploadButton } from './UploadButton';
import { DocumentPanel } from './DocumentPanel';
import type { DocumentDTO, ID, TextStatus } from '../../types';

/**
 * What each non-`ok` extraction state MEANS, in words a person can act on.
 *
 * These are never hidden. A scanned contract that silently sits there looking like every other
 * file is how someone concludes the feature is broken — or worse, trusts an empty commitment list
 * as "nothing was promised" (D4). `ok` says nothing, because a file that worked needs no notice.
 * An absent or unrecognised value also says nothing: an older server simply does not send the
 * field, and inventing "reading…" for it would be a status we made up.
 */
const TEXT_STATUS_NOTE: Partial<Record<TextStatus, string>> = {
  pending: 'reading…',
  no_text_layer: 'looks like a scan — its text can’t be read',
  unsupported: 'this file type has no text to read',
  too_large: 'too large to read',
  failed: 'couldn’t be read — the file may be damaged',
};

function statusNote(status: TextStatus | undefined): string | null {
  return (status && TEXT_STATUS_NOTE[status]) ?? null;
}

/** "6 commitments · 4 accepted" — the payoff of rung 3, visible without opening the document. */
function commitmentNote(counts: DocumentDTO['itemCounts']): string | null {
  const total = (counts?.proposed ?? 0) + (counts?.accepted ?? 0);
  if (!total) return null;
  const found = `${total} commitment${total === 1 ? '' : 's'}`;
  return counts?.accepted ? `${found} · ${counts.accepted} accepted` : found;
}

/** Bytes as a person reads them. One decimal under 10 units, none above — 1.4 MB, 12 MB. */
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/**
 * An upload in flight, or one that failed and is still on screen waiting to be retried.
 *
 * Component state, not store state — so leaving the view mid-upload loses the progress row (the
 * request itself continues, and the file appears on the next load if it lands). Lifting this into
 * the store would mean a second, parallel notion of "pending write" living next to the outbox, for
 * a case the user can always see coming; if it starts biting, that is the trade to revisit.
 */
interface Upload {
  key: string;
  file: File;
  progress: number; // 0..1, straight from XHR
  error?: string;
}

const NO_DOCS: DocumentDTO[] = [];

export function DocumentStrip({ boardId, taskId, variant }: {
  boardId: ID;
  /** Present on a task page: the strip then shows (and attaches) only that task's files. */
  taskId?: ID;
  variant: 'task' | 'board';
}) {
  const all = useStore((s) => s.documentsByBoard[boardId]) ?? NO_DOCS;
  const loading = useStore((s) => s.documentsLoading[boardId]) ?? false;
  const error = useStore((s) => s.documentsError[boardId]) ?? null;
  const members = useStore((s) => s.membersByBoard[boardId]);
  const role = useStore((s) => s.tabs[boardId]?.role);
  const loadDocuments = useStore((s) => s.loadDocuments);
  const addDocument = useStore((s) => s.addDocument);
  const removeDocument = useStore((s) => s.removeDocument);
  const setDocumentsError = useStore((s) => s.setDocumentsError);
  // Same gate the task page uses for its fields: a viewer may read and download, and is shown no
  // affordance they cannot use. Missing role is treated as read-only (types.ts: "read-only-safe").
  const editable = role === 'editor' || role === 'admin';

  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [openId, setOpenId] = useState<ID | null>(null);

  // One fetch per board serves both surfaces — the list route returns the board's task-attached
  // files too, and `?taskId=` only narrows it. Filtering here instead means a task strip and a
  // board strip open at once cannot disagree, and one live frame updates both.
  useEffect(() => {
    void loadDocuments(boardId);
  }, [boardId, loadDocuments]);

  const docs = useMemo(
    // A fresh array straight out of the selector would make useSyncExternalStore see a new
    // snapshot every render (the same trap useTasksForTab documents).
    () => (taskId ? all.filter((d) => d.taskId === taskId) : all),
    [all, taskId],
  );

  const nameOf = useMemo(() => {
    const map = new Map((members ?? []).map((m) => [m.id, m.name]));
    return (id: ID | undefined) => (id ? map.get(id) ?? 'someone' : 'someone');
  }, [members]);

  function startUploads(files: File[]): void {
    setDocumentsError(boardId, null);
    for (const file of files) {
      const key = `${file.name}:${file.size}:${Date.now()}:${Math.random()}`;
      setUploads((u) => [...u, { key, file, progress: 0 }]);
      void send(key, file);
    }
  }

  async function send(key: string, file: File): Promise<void> {
    setUploads((u) => u.map((x) => (x.key === key ? { ...x, progress: 0, error: undefined } : x)));
    try {
      const doc = await api.documents.upload(boardId, file, {
        taskId,
        onProgress: (p) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, progress: p } : x))),
      });
      addDocument(doc);
      // addDocument has nothing to add to if the board's list has not arrived yet — which is
      // exactly the case when someone drops a file the instant a board opens. Pull the list so the
      // file they just watched upload is actually on screen.
      if (!useStore.getState().documentsByBoard[boardId]?.some((d) => d.id === doc.id)) {
        void loadDocuments(boardId);
      }
      setUploads((u) => u.filter((x) => x.key !== key));
    } catch (e) {
      // Stays on screen with the reason. The server's own message (quota reached, file too large,
      // storage not configured) is far more useful than anything we could substitute for it.
      const message = e instanceof Error ? e.message : 'upload failed';
      setUploads((u) => u.map((x) => (x.key === key ? { ...x, error: message } : x)));
    }
  }

  async function onDelete(doc: DocumentDTO): Promise<void> {
    const ok = await askConfirm({
      title: `Delete “${doc.filename}”?`,
      body: (
        <p>
          It disappears from this board for everyone. The file itself is kept server-side and can be
          restored, but nothing in the app lists deleted files yet.
        </p>
      ),
      confirmLabel: 'Delete file',
    });
    if (!ok) return;
    await removeDocument(boardId, doc.id);
  }

  // Not while the panel is open: it renders as a fixed backdrop over the whole screen from inside
  // this element, so a file dropped ON the panel would otherwise land as an upload behind it.
  const dropProps = editable && !openId
    ? {
        onDragOver: (e: React.DragEvent) => {
          // Without preventDefault the browser navigates to the dropped file and the whole page
          // is gone, unsaved edits with it.
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          if (!dragging) setDragging(true);
        },
        onDragLeave: (e: React.DragEvent) => {
          // Dragging across a child element fires dragleave on the container; only a leave that
          // actually exits the card counts.
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setDragging(false);
        },
        onDrop: (e: React.DragEvent) => {
          e.preventDefault();
          setDragging(false);
          const files = Array.from(e.dataTransfer.files ?? []);
          if (files.length) startUploads(files);
        },
      }
    : {};

  const empty = docs.length === 0 && uploads.length === 0;

  return (
    <section
      className={`doc-strip is-${variant} ${dragging ? 'is-dragging' : ''}`}
      aria-label={taskId ? 'Files on this task' : 'Files on this board'}
      {...dropProps}
    >
      <header className="doc-strip-head">
        <span className="doc-strip-title">Files{docs.length ? ` · ${docs.length}` : ''}</span>
        {editable && <UploadButton onFiles={startUploads} label="Add a file" />}
      </header>

      {error && <p className="doc-strip-error" role="status">{error}</p>}

      {empty ? (
        <p className="doc-strip-empty">
          {loading
            ? 'Loading…'
            : editable
              ? // A real invitation, and it names the thing this feature is for. "No files" in a
                // grey box tells someone nothing about what to do next.
                'No files yet. Drop a contract, brief or statement of work here — or use Add a file.'
              : 'No files attached.'}
        </p>
      ) : (
        <ul className="doc-list">
          {uploads.map((u) => (
            <li key={u.key} className={`doc-row is-upload ${u.error ? 'is-failed' : ''}`}>
              <span className="doc-row-main">
                <span className="doc-name">{u.file.name}</span>
                <span className="doc-meta">
                  {formatSize(u.file.size)}
                  {u.error ? '' : ` · ${Math.round(u.progress * 100)}%`}
                </span>
                {u.error ? (
                  <span className="doc-note is-bad">{u.error}</span>
                ) : (
                  <span className="doc-progress" aria-hidden>
                    <span className="doc-progress-fill" style={{ width: `${Math.round(u.progress * 100)}%` }} />
                  </span>
                )}
              </span>
              {u.error && (
                <span className="doc-row-actions">
                  <button type="button" className="btn ghost tiny" onClick={() => void send(u.key, u.file)}>
                    Retry
                  </button>
                  <button
                    type="button"
                    className="btn ghost tiny"
                    onClick={() => setUploads((list) => list.filter((x) => x.key !== u.key))}
                  >
                    Dismiss
                  </button>
                </span>
              )}
            </li>
          ))}

          {docs.map((d) => {
            const note = statusNote(d.textStatus);
            const commitments = commitmentNote(d.itemCounts);
            return (
              <li key={d.id} className="doc-row">
                <button
                  type="button"
                  className="doc-row-main doc-row-open"
                  onClick={() => setOpenId(d.id)}
                  title="Open this file"
                >
                  <span className="doc-name">{d.filename}</span>
                  <span className="doc-meta">
                    {formatSize(d.size)}
                    {/* Uploader and date are the board view's extra column of context: on a task
                        page the file is already in the middle of the task's own story. */}
                    {variant === 'board' && d.uploadedBy ? ` · ${nameOf(d.uploadedBy)}` : ''}
                    {variant === 'board' && d.createdAt ? ` · ${timeAgo(new Date(d.createdAt).toISOString())}` : ''}
                  </span>
                  {/* Shown on BOTH surfaces. Whether a file can be read is not board-view trivia —
                      it is the reason a contract will or will not produce a commitment list. */}
                  {note && <span className={`doc-note ${d.textStatus === 'pending' ? '' : 'is-bad'}`}>{note}</span>}
                  {commitments && <span className="doc-note is-found">{commitments}</span>}
                </button>
                <span className="doc-row-actions">
                  {/* A plain link. The session cookie authenticates it, so pulling the bytes
                      through JS would only mean holding a whole file in memory to hand the
                      browser something it can already do — and it would break the progressive
                      download of a large file. */}
                  <a
                    className="doc-action"
                    href={api.documents.contentUrl(d.id)}
                    download={d.filename}
                    title={`Download ${d.filename}`}
                    aria-label={`Download ${d.filename}`}
                  >
                    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
                      <path d="M8 2v8m0 0L5 7m3 3l3-3M3 13h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                    </svg>
                  </a>
                  {editable && (
                    <button
                      type="button"
                      className="doc-action doc-delete"
                      onClick={() => void onDelete(d)}
                      title={`Delete ${d.filename}`}
                      aria-label={`Delete ${d.filename}`}
                    >
                      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
                        <path d="M4 4l8 8M12 4L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                      </svg>
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {/* The review panel is its own component (rung 3); the strip only knows how to open one
          by id and how to be told it closed. */}
      {openId && <DocumentPanel documentId={openId} onClose={() => setOpenId(null)} />}
    </section>
  );
}
