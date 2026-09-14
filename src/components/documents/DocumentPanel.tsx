// One uploaded document, and the commitments read out of it (CONTRACT_TO_PROJECT_PLAN rung 3).
// Opened by id from either attachment strip; a panel rather than a route because a route implies
// a permanent place for this, and rung 4 is what decides that.
//
// The whole feature is a trust argument, so the component is built around one: every row carries
// the document's own words, the header says out loud that this is a reading and not an authority
// (D8), and nothing is ever hidden for being low-confidence — a row nobody sees is a row nobody
// reviews, which is the failure this panel exists to prevent.
//
// Every non-happy path here is a SENTENCE, not an empty box: a scan, an unreadable file, an
// unconfigured model, a run that found nothing. Those states are the common case on real uploads,
// and a blank panel would read as a bug rather than as the file being what it is.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { useStore } from '../../store';
import { ItemRow } from './ItemRow';
import { timeAgo } from '../../util/dates';
import {
  ITEM_KINDS,
  ITEM_KIND_LABEL,
  type DocumentDTO,
  type DocumentItem,
  type ExtractionRun,
  type ID,
  type ItemKind,
  type TextStatus,
} from '../../types';

/** How often a running extraction is re-read. Runs are minutes at most (§4) and each poll is one
 *  small query, so this is frequent enough to feel live without being a busy loop. */
const POLL_MS = 2000;
/** Same idea for a file whose text is still being pulled out — that job is seconds, not minutes. */
const TEXT_POLL_MS = 3000;

/**
 * Kinds that keep their heading even when nothing was found (D11).
 *
 * "Out of scope — none found" is information a reader can act on; an omitted heading is
 * indistinguishable from a feature that never looked. Every tool lists deliverables, and these two
 * are the reason this panel is worth opening at all, so they are not allowed to quietly disappear
 * on the documents where they happen to be empty.
 */
const ALWAYS_SHOWN: ItemKind[] = ['exclusion', 'limit'];

/**
 * Why this document yielded no text, in the reader's terms. Each of these is a real outcome of a
 * real upload, and the wording matters: "this looks like a scan" tells someone what to do next,
 * where "no text" tells them nothing (D4).
 */
const TEXT_STATUS_NOTE: Record<Exclude<TextStatus, 'ok'>, string> = {
  pending: 'Still reading this file — commitments can be found once its text is out. This updates on its own.',
  no_text_layer:
    'This looks like a scan — the pages are images with no text behind them, so nothing can be read out of it. A text-based PDF or a Word file would work.',
  unsupported: 'This file type isn’t one the text reader handles. PDF, Word documents and plain text files are.',
  too_large: 'This file is past the size cap for text extraction, so its text was never read.',
  failed: 'The text couldn’t be read out of this file — it may be damaged, or password-protected.',
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** A short, human file-type label. The mime type itself is noise in a header. */
function typeLabel(mime: string): string {
  if (mime === 'application/pdf') return 'PDF';
  if (mime.includes('wordprocessingml')) return 'DOCX';
  if (mime === 'application/msword') return 'DOC';
  if (mime.startsWith('text/')) return mime === 'text/plain' ? 'Text' : mime.slice(5).toUpperCase();
  const sub = mime.split('/')[1] ?? mime;
  return (sub.split(/[.+]/).pop() ?? sub).toUpperCase().slice(0, 8);
}

/** Strip the `METHOD /path -> 404` prefix the api client puts on its errors. */
function plainError(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message.replace(/^.*->\s*\d+\s*/, '') || fallback : fallback;
}

export function DocumentPanel({ documentId, onClose }: { documentId: ID; onClose: () => void }) {
  const [doc, setDoc] = useState<DocumentDTO | null>(null);
  const [items, setItems] = useState<DocumentItem[] | null>(null);
  const [run, setRun] = useState<ExtractionRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The document's text, fetched lazily — see loadText(). Null = not asked for yet.
  const [text, setText] = useState<string | null>(null);
  const [textFailed, setTextFailed] = useState(false);
  // Extraction is off on this server (503). Not an error: it is a configuration the operator chose,
  // exactly like S3 or push being absent, so it gets a sentence and not a red box.
  const [aiOff, setAiOff] = useState(false);
  // A 202 has been accepted but no run has shown up in the list yet. Polls until it does.
  const [starting, setStarting] = useState(false);
  /**
   * Local, un-acked changes to rows, keyed by item id. Accept/reject/edit go through the durable
   * outbox, which resolves when the write actually lands — possibly much later, if the phone is
   * offline. Blocking the row on that would make the panel unusable exactly where this app
   * promises it still works, so the row flips immediately and this holds the difference until a
   * fresh read agrees. It also stops the run poller from yanking a row back mid-review.
   */
  const [overrides, setOverrides] = useState<Record<ID, Partial<DocumentItem>>>({});

  // The board's own role decides what a person may do here. Unknown until the document tells us
  // which board it is on, and unknown is treated as read-only (types.ts: read-only-safe).
  const role = useStore((s) => (doc ? s.tabs[doc.tabId]?.role : undefined));
  const members = useStore((s) => (doc ? s.membersByBoard[doc.tabId] : undefined));
  const editable = role === 'editor' || role === 'admin';

  const loadDoc = useCallback(async () => {
    try {
      const res = await api.documents.get(documentId);
      setDoc(res.document);
    } catch (e) {
      setError(plainError(e, 'This document couldn’t be loaded.'));
    }
  }, [documentId]);

  const loadItems = useCallback(async () => {
    try {
      const res = await api.items.list(documentId);
      setItems(res.items);
      setRun(res.run);
      setAiOff(false);
      // Only 'idle' means "the 202 hasn't surfaced yet"; anything else is a real answer.
      if (res.run.status !== 'idle') setStarting(false);
    } catch (e) {
      // 503 is the server saying this feature isn't switched on — see aiOff.
      if (e instanceof ApiError && e.status === 503) {
        setItems([]);
        setRun(null);
        setAiOff(true);
        setStarting(false);
        return;
      }
      setError(plainError(e, 'The commitments on this document couldn’t be loaded.'));
    }
  }, [documentId]);

  /**
   * The document's full text, pulled only when someone actually opens a citation. A 40-page
   * contract is a lot of characters to push at a phone on the chance a row gets expanded, and most
   * panel opens never expand one — so this is a second request rather than a fatter first one.
   */
  const loadText = useCallback(async () => {
    try {
      const res = await api.documents.get(documentId, true);
      setDoc(res.document);
      if (res.text) setText(res.text);
      else setTextFailed(true); // the row cites text the server no longer has
    } catch {
      setTextFailed(true);
    }
  }, [documentId]);

  useEffect(() => {
    // Both resolve long after the effect returns; the rule can't see through the await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadDoc();
    void loadItems();
  }, [loadDoc, loadItems]);

  useEffect(() => {
    if (!starting && run?.status !== 'running') return;
    const poll = setInterval(() => void loadItems(), POLL_MS);
    // A 202 the server then forgets (runs live in memory, §4, so a restart drops them) would
    // otherwise leave this polling for as long as the panel stays open. Give up after a minute:
    // whatever landed is already on screen, and the button is right there to try again.
    const giveUp = setTimeout(() => setStarting(false), 60_000);
    return () => {
      clearInterval(poll);
      clearTimeout(giveUp);
    };
  }, [starting, run?.status, loadItems]);

  useEffect(() => {
    if (doc?.textStatus !== 'pending') return;
    // Text extraction runs after the upload response (D2), so a document opened straight after
    // upload is usually mid-read. Polling turns "still reading this file" into a state that
    // resolves itself instead of one that needs a reload to clear.
    const t = setInterval(() => void loadDoc(), TEXT_POLL_MS);
    return () => clearInterval(t);
  }, [doc?.textStatus, loadDoc]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const merged = useMemo(
    () => (items ?? []).map((it) => (overrides[it.id] ? { ...it, ...overrides[it.id] } : it)),
    [items, overrides],
  );

  /**
   * Apply a change to one row optimistically, then reconcile against the server.
   *
   * The reconcile matters as much as the optimism: the outbox does not reject, it re-pulls, so a
   * write the server refused would otherwise sit here looking accepted forever. Re-reading and
   * then dropping the override lets the truth win either way.
   */
  const patchItem = useCallback(
    (id: ID, body: { status?: 'accepted' | 'rejected'; text?: string; dueDate?: string | null }, local: Partial<DocumentItem>) => {
      setOverrides((o) => ({ ...o, [id]: { ...o[id], ...local, editedAt: Date.now() } }));
      void api.items
        .update(id, body)
        .then(() => loadItems())
        .finally(() =>
          setOverrides((o) => {
            const next = { ...o };
            delete next[id];
            return next;
          }),
        );
    },
    [loadItems],
  );

  const proposed = merged.filter((i) => i.status === 'proposed');

  function acceptAll() {
    const now = Date.now();
    const ids = proposed.map((i) => i.id);
    setOverrides((o) => {
      const next = { ...o };
      for (const id of ids) next[id] = { ...next[id], status: 'accepted', editedAt: now };
      return next;
    });
    void api.items
      .acceptAll(documentId)
      .then(() => loadItems())
      .finally(() =>
        // Only the ids this accepted — a row someone edited while the bulk write was in flight
        // still has its own reconcile coming.
        setOverrides((o) => {
          const next = { ...o };
          for (const id of ids) delete next[id];
          return next;
        }),
      );
  }

  async function startExtract() {
    setError(null);
    setStarting(true);
    try {
      await api.items.extract(documentId);
      await loadItems();
    } catch (e) {
      setStarting(false);
      if (e instanceof ApiError && e.status === 503) {
        setAiOff(true);
        return;
      }
      if (e instanceof ApiError && e.status === 409) {
        // The text isn't readable — the panel already says why, just above the button.
        await loadDoc();
        return;
      }
      setError(plainError(e, 'The extraction couldn’t be started.'));
    }
  }

  const uploader = doc?.uploadedBy ? members?.find((m) => m.id === doc.uploadedBy)?.name : undefined;
  const running = starting || run?.status === 'running';
  const finished = run?.status === 'done';

  // "Something has been read out of this document" — true for a run that just finished AND for one
  // that finished last week, since runs are only tracked in memory (§4) and report 'idle' after a
  // restart. The empty-kind headings below key off this rather than off `finished`, or they would
  // vanish on every document revisited after a deploy.
  const hasResults = finished || merged.length > 0;
  const groups = ITEM_KINDS.map((kind) => ({ kind, rows: merged.filter((i) => i.kind === kind) })).filter(
    (g) => g.rows.length > 0 || (hasResults && ALWAYS_SHOWN.includes(g.kind)),
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="share-panel document-panel"
        role="dialog"
        aria-modal="true"
        aria-label={doc?.filename ?? 'Document'}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="share-head doc-panel-head">
          <div className="doc-panel-title">
            <strong>{doc?.filename ?? 'Document'}</strong>
            {doc && (
              <div className="doc-panel-sub">
                {formatBytes(doc.size)} · {typeLabel(doc.mime)}
                {doc.textChars ? ` · ${doc.textChars.toLocaleString()} characters read` : ''}
                {uploader ? ` · uploaded by ${uploader}` : ''}
                {doc.createdAt ? ` · ${timeAgo(new Date(doc.createdAt).toISOString())}` : ''}
              </div>
            )}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="close">✕</button>
        </header>

        {error && <div className="share-error">{error}</div>}

        <div className="doc-panel-actions">
          {/* A plain link: the session cookie authenticates it, so there is nothing for JS to do. */}
          {doc && (
            <a className="btn ghost" href={api.documents.contentUrl(doc.id)} target="_blank" rel="noreferrer">
              Open the file
            </a>
          )}
          {doc && doc.textStatus === 'ok' && editable && !aiOff && (
            <button type="button" className="btn primary" onClick={() => void startExtract()} disabled={running}>
              {running ? 'Reading…' : merged.length ? 'Look again' : 'Find commitments'}
            </button>
          )}
        </div>

        {doc && doc.textStatus !== 'ok' && <p className="doc-panel-note">{TEXT_STATUS_NOTE[doc.textStatus]}</p>}

        {aiOff && (
          <p className="doc-panel-note">
            Finding commitments needs a model endpoint, and this server doesn’t have one configured. Set{' '}
            <code>AI_ENDPOINT</code> and <code>AI_MODEL</code> — see <code>.env.example</code>.
          </p>
        )}

        {doc && doc.textStatus === 'ok' && !editable && !aiOff && merged.length === 0 && !running && (
          <p className="doc-panel-note">Nothing has been read out of this document yet. An editor on this board can start that.</p>
        )}

        {running && (
          <div className="doc-panel-running" role="status">
            <span className="doc-panel-bar" aria-hidden />
            <span>
              Reading the document…{' '}
              {merged.length ? `${merged.length} found so far` : 'nothing found yet'}
            </span>
          </div>
        )}

        {run?.status === 'error' && (
          <p className="doc-panel-note is-bad">The run stopped: {run.error ?? 'the model didn’t answer.'}</p>
        )}

        {merged.length > 0 && (
          <div className="doc-panel-summary">
            <div className="doc-panel-count">
              <strong>{merged.length} found</strong> · review before relying on these
            </div>
            {/* D8, stated where it cannot be missed. The model read the text; a person decides what
                any of it means. Saying so is not a disclaimer bolt-on — it is the product. */}
            <p className="doc-panel-caveat">
              Each line below was read out of the document and its quote checked, word for word, against the file. It is
              still a reading — the document itself is the only authority, and this is not legal advice.
            </p>
            {editable && proposed.length > 0 && (
              <button type="button" className="btn ghost doc-panel-acceptall" onClick={acceptAll}>
                Accept all {proposed.length}
              </button>
            )}
          </div>
        )}

        {groups.map((g) => (
          <section key={g.kind} className="doc-group">
            <h4 className="doc-group-head">
              {ITEM_KIND_LABEL[g.kind]} <span className="doc-group-count">{g.rows.length}</span>
            </h4>
            {g.rows.length === 0 ? (
              <p className="doc-group-empty">
                None found. Worth a look in the document yourself — this is the part a contract is most likely to bury.
              </p>
            ) : (
              <ul className="doc-item-list">
                {g.rows.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    editable={editable}
                    text={text}
                    textUnavailable={textFailed}
                    onNeedText={() => {
                      if (text === null && !textFailed) void loadText();
                    }}
                    onStatus={(status) => patchItem(item.id, { status }, { status })}
                    onEdit={(p) => {
                      // Only the keys actually being changed: an override carrying `text:
                      // undefined` would spread over the row and blank it, so editing just a date
                      // would erase the line it belongs to.
                      const local: Partial<DocumentItem> = {};
                      if (p.text !== undefined) local.text = p.text;
                      if (p.dueDate !== undefined) local.dueDate = p.dueDate ?? undefined;
                      patchItem(item.id, p, local);
                    }}
                  />
                ))}
              </ul>
            )}
          </section>
        ))}

        {finished && merged.length === 0 && (
          <p className="doc-panel-note">
            No commitments found. This may not be a contract, or the wording may be unusual enough that the model didn’t
            recognise it — the document is unchanged either way.
          </p>
        )}

        {/* Surfaced, quietly, because a high number is the signal that the model or the prompt is
            bad (D6) — and because "we threw some away" is exactly the kind of thing a trust
            feature should not keep to itself. */}
        {finished && !!run?.dropped && (
          <p className="doc-panel-dropped">
            {run.dropped} suggestion{run.dropped === 1 ? '' : 's'} {run.dropped === 1 ? 'was' : 'were'} discarded for
            quoting words that aren’t in this document.
          </p>
        )}

        {items === null && !error && !aiOff && <p className="share-empty">Loading…</p>}
      </div>
    </div>
  );
}
