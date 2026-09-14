// Pulling commitments out of a contract (CONTRACT_TO_PROJECT_PLAN.md §4, D6/D7/D10).
//
// The pipeline: chunk the extracted text -> one forced-JSON completion per chunk -> VERIFY every
// quote against the document -> dedupe -> insert what survives as `proposed`.
//
// ============================================================================================
// READ THIS BEFORE SIMPLIFYING `verifyQuote`.
//
// The quote check is not a validation nicety and it is not defensive programming. It is the
// entire reason this feature is allowed to exist. A model asked to find obligations in legalese
// WILL produce plausible, well-formed, completely invented deliverables — that is the normal
// failure mode of the task, not an edge case. An invented deliverable in a contract review tool
// is worse than no tool at all, because a human reads it, believes it, and acts on it: they
// schedule work nobody agreed to, or they stop looking for the clause that really was there.
//
// So: the model must quote the source verbatim, the server checks that the quote is really there,
// and anything that fails is DROPPED — never stored, never shown, never "flagged for review".
// The cost is one indexOf per item. The benefit is that a weak local model degrades by producing
// FEWER items rather than wrong ones, which is the only degradation mode acceptable here (§8).
//
// If you are here because the drop count looks high: that is the gate WORKING, and telling you
// the prompt or the model is bad. Fix the prompt. Do not widen the gate.
// ============================================================================================
//
// D7 is enforced structurally rather than by a condition: a run only ever INSERTs. No code path in
// this file updates or deletes an existing `document_items` row, so an item a human accepted,
// rejected or corrected cannot be touched by re-running extraction. Keep it that way.

import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, schema } from '../db/client.ts';
import { recordAudit } from './audit.ts';
import { publish, boardChannel } from './bus.ts';
import { chatJSON, aiModel, type ChatMessage } from './ai.ts';

/** D10: a 40-page MSA does not fit one prompt, and overlap keeps a straddling clause whole. */
export const CHUNK_CHARS = 12_000;
export const CHUNK_OVERLAP = 1_000;

/**
 * A quote shorter than this is dropped even when it IS present, because presence proves nothing:
 * "the Agency" appears in every contract ever written, so a model that emits it has not actually
 * cited anything. Eight characters keeps genuinely short factual spans ("30 days", "$12,500") and
 * kills single words.
 */
const MIN_QUOTE_CHARS = 8;

/** D11. The valuable kinds are `exclusion` and `limit`, not `deliverable`. */
const KINDS = new Set(['deliverable', 'exclusion', 'date', 'payment', 'limit']);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Hard stop on one run's output. A model stuck in a loop must not fill a board with rows. */
const MAX_ITEMS_PER_RUN = 500;

// ---- the prompt ---------------------------------------------------------------------------
//
// Everything about this prompt aims at one thing: making the model COPY rather than WRITE.
//
// The kind list is spelled out because "find the commitments" collapses the taxonomy — models
// default to `deliverable` and the exclusions and limits that make this feature worth building
// never appear (D11). "An empty array is a CORRECT answer" is load-bearing too: handed a page of
// governing-law boilerplate, a model with no permission to return nothing will manufacture
// something.

const SYSTEM_PROMPT = `You extract commitments from a contract. You are shown ONE excerpt of a longer document.

Reply with JSON of exactly this shape and nothing else:
{"items": [{"kind": "...", "text": "...", "source_quote": "...", "due_date": "YYYY-MM-DD", "confidence": 0.0}]}

"kind" must be exactly one of:
  deliverable - something a party must produce, provide, or perform
  exclusion   - something explicitly NOT included, out of scope, or carved out
  date        - a deadline, milestone, term, renewal, or notice period
  payment     - an amount, rate, invoice trigger, or payment schedule
  limit       - a cap or bound: revision rounds, hours, liability, SLA, headcount

Rules:
- "source_quote" MUST be copied from the excerpt EXACTLY, character for character. Never paraphrase
  it. Never shorten it with "...". Never correct its spelling, capitalisation, or punctuation. If
  you cannot copy an exact span of the excerpt that supports the item, do not return the item.
- Quote the smallest span that still proves the commitment, usually one clause or sentence.
- "text" is YOUR OWN one-line plain-language summary of the commitment, under 120 characters.
- "due_date" only when "kind" is "date" AND the excerpt states an absolute calendar date. Omit it
  otherwise. Never compute, infer, or guess a date.
- "confidence" is your own estimate between 0 and 1.
- If this excerpt contains no commitments, return {"items": []}. An empty array is a CORRECT
  answer, and is the right answer for headings, definitions, governing law, and boilerplate.
- Never invent. Everything you return must be supported by text you can quote from the excerpt.`;

function userPrompt(chunk: string): string {
  // Delimited so the model can tell contract prose from instructions, and so an instruction-shaped
  // sentence inside a contract reads as content rather than as a command.
  return `Excerpt of the document:\n\n<<<BEGIN EXCERPT>>>\n${chunk}\n<<<END EXCERPT>>>`;
}

// ---- chunking (D10) -----------------------------------------------------------------------

export interface Chunk {
  text: string;
  /** Offset of this chunk in the original text. Not used for storage — offsets are recomputed
   *  against the whole document — but it makes a bad run debuggable. */
  start: number;
}

export function chunkText(text: string): Chunk[] {
  if (text.length === 0) return [];
  if (text.length <= CHUNK_CHARS) return [{ text, start: 0 }];
  const stride = Math.max(1, CHUNK_CHARS - CHUNK_OVERLAP);
  const chunks: Chunk[] = [];
  for (let start = 0; start < text.length; start += stride) {
    chunks.push({ text: text.slice(start, start + CHUNK_CHARS), start });
    if (start + CHUNK_CHARS >= text.length) break;
  }
  return chunks;
}

// ---- quote verification (D6) --------------------------------------------------------------

/**
 * Collapse every run of whitespace to a single space, and trim.
 *
 * Whitespace is normalised on BOTH sides of the comparison, and nothing else is. That asymmetry is
 * the point. `unpdf` and `mammoth` reflow text with a line break wherever the page happened to
 * wrap, so a model quoting a clause perfectly still fails a raw `indexOf` — whitespace differences
 * are a fact about the extractor, not evidence about the model's honesty.
 *
 * Case, punctuation, quote marks and dashes are deliberately NOT normalised. Each additional
 * normalisation is a class of paraphrase that starts passing the gate, and once you are rewriting
 * both sides, "the model swapped a curly quote" stops being distinguishable from "the model
 * rewrote the clause". A real item lost to a smart-quote mismatch is a cheap mistake; an invented
 * item stored because we were lenient is an expensive one.
 */
export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * The whitespace-normalised document PLUS a map from each normalised character back to its index
 * in the original text.
 *
 * The map exists so `source_offset` points into `documents.text_content`, which is what the UI
 * slices to show context. An offset into a normalised copy nobody else holds would send the reader
 * to the wrong paragraph — worse than storing nothing, because it looks authoritative.
 */
function normalizeWithMap(text: string): { norm: string; map: Int32Array } {
  const chars: string[] = [];
  const map = new Int32Array(text.length);
  let n = 0;
  let pendingSpace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (WS.test(ch)) {
      if (n > 0) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      chars.push(' ');
      // A collapsed run maps to the index of the character that ENDS it. A match practically
      // always begins on a non-space (quotes are trimmed before the search), so this only affects
      // an offset nobody reads, and it keeps the map monotonic.
      map[n++] = i;
      pendingSpace = false;
    }
    chars.push(ch);
    map[n++] = i;
  }
  return { norm: chars.join(''), map };
}

// Single-character test, so it is compiled once rather than per character. `\s` already covers the
// Unicode spaces PDFs are full of (NBSP, en quad, narrow NBSP, BOM), which is exactly the set that
// would otherwise make legitimate quotes unverifiable.
const WS = /\s/;

export interface VerifiedQuote {
  /** The span EXACTLY as the document has it — not the model's copy of it. */
  quote: string;
  /** Offset into the ORIGINAL text, for jump-to-context. */
  offset: number;
  /** Normalised form; the dedupe key. */
  normalized: string;
}

export interface DocIndex {
  text: string;
  norm: string;
  map: Int32Array;
}

export function indexDocument(text: string): DocIndex {
  return { text, ...normalizeWithMap(text) };
}

/**
 * Does this quote really occur in the document? Returns where, or null.
 *
 * Note what is stored on success: the ORIGINAL span, sliced out of the document at the verified
 * position — not the string the model sent. The two are equal up to whitespace by construction,
 * and taking the document's copy means the quote a reviewer reads is provably the document's own
 * words, with its own line breaks, and cannot be subtly off by a character the model changed.
 */
export function verifyQuote(quote: string, doc: DocIndex): VerifiedQuote | null {
  const needle = normalizeWhitespace(quote);
  if (needle.length < MIN_QUOTE_CHARS) return null;
  const at = doc.norm.indexOf(needle);
  if (at === -1) return null;
  const start = doc.map[at];
  // +1 because the map holds the index of the last character, not the position after it.
  const end = doc.map[at + needle.length - 1] + 1;
  return { quote: doc.text.slice(start, end), offset: start, normalized: needle };
}

// ---- model output -------------------------------------------------------------------------

interface RawItem {
  kind: string;
  text: string;
  sourceQuote: string;
  dueDate?: string;
  confidence?: number;
}

/**
 * Pull usable items out of whatever the model actually returned.
 *
 * Accepts `{items: [...]}` (what the prompt asks for) and a bare `[...]` (what several small
 * models return regardless of the prompt). Anything else yields nothing — a chunk that produces
 * garbage contributes zero items instead of failing the run, so one bad page of a 40-page contract
 * stays a bad page rather than becoming a lost run.
 */
function parseItems(payload: unknown): RawItem[] {
  const out: RawItem[] = [];
  for (const entry of rawArray(payload)) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const kind = typeof e.kind === 'string' ? e.kind.trim().toLowerCase() : '';
    const text = typeof e.text === 'string' ? e.text.trim() : '';
    const quote = typeof e.source_quote === 'string' ? e.source_quote : '';
    if (!KINDS.has(kind) || text === '' || quote === '') continue;
    const due = typeof e.due_date === 'string' && ISO_DATE.test(e.due_date) ? e.due_date : undefined;
    const conf = typeof e.confidence === 'number' && !Number.isNaN(e.confidence) ? e.confidence : undefined;
    out.push({
      kind,
      // Bounded: `text` is model prose and the only stored field with no verification behind it.
      text: text.slice(0, 500),
      sourceQuote: quote,
      // A due date only ever belongs to a `date` item. A model attaching one to a payment row is
      // guessing, and a guessed date in a contract tool is what D6 exists to prevent.
      dueDate: kind === 'date' ? due : undefined,
      confidence: conf === undefined ? undefined : Math.min(1, Math.max(0, conf)),
    });
  }
  return out;
}

function rawArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const items = (payload as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? items : [];
}

// ---- run state (§4, last paragraph) -------------------------------------------------------
//
// In memory, not a table. A run is minutes at most, and a restart losing one means the user
// presses the button again — the ITEMS are durable, which is the part that matters. A runs table
// is rung 4's problem, when generated tasks need to point back at the run that produced them.

export type RunStatus = 'idle' | 'running' | 'done' | 'error';

export interface RunState {
  runId: string;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  chunks?: number;
  proposed?: number;
  /** Items the model returned whose quote was NOT in the document (D6). A high number is the
   *  signal that the model or the prompt is bad, which is why it is surfaced, not swallowed. */
  dropped?: number;
  error?: string;
}

const runs = new Map<string, RunState>();

export function runState(documentId: string): RunState | undefined {
  return runs.get(documentId);
}

function isRunning(documentId: string): boolean {
  return runs.get(documentId)?.status === 'running';
}

/** The `run` half of `GET /api/documents/:id/items`. `idle` when this process never ran one. */
export function runDTO(documentId: string): {
  status: RunStatus;
  startedAt?: number;
  error?: string;
  proposed?: number;
  dropped?: number;
} {
  const r = runs.get(documentId);
  if (!r) return { status: 'idle' };
  return { status: r.status, startedAt: r.startedAt, error: r.error, proposed: r.proposed, dropped: r.dropped };
}

export interface StartArgs {
  documentId: string;
  tabId: string;
  actorId: string;
  text: string;
}

/**
 * Kick off a run and return immediately — the route answers 202 and the UI polls `runDTO`.
 *
 * Returns null when a run is already in flight for this document. Concurrency is refused rather
 * than queued because two runs over the same text would each dedupe against the rows that existed
 * when they STARTED, and both would then insert the same items.
 */
export function startExtraction(args: StartArgs): RunState | null {
  if (isRunning(args.documentId)) return null;
  const state: RunState = { runId: nanoid(), status: 'running', startedAt: Date.now() };
  runs.set(args.documentId, state);
  // Fire and forget: the request is over long before this resolves. `execute` never rejects — it
  // records the failure on the run state instead.
  void execute(args, state);
  return state;
}

async function execute(args: StartArgs, state: RunState): Promise<void> {
  const { documentId, tabId, actorId, text } = args;
  const model = aiModel() ?? 'unknown';
  const chunks = chunkText(text);
  state.chunks = chunks.length;

  const doc = indexDocument(text);

  // Rows already on this document, keyed the way the dedupe compares. Includes ACCEPTED, REJECTED
  // and HUMAN-EDITED rows on purpose (D7): re-proposing something a person already rejected, or
  // re-adding one they corrected, is precisely the behaviour that would make the feature
  // untrusted. `source_quote` is immutable through the API so this key survives an edit.
  const existing = await db
    .select({ kind: schema.documentItems.kind, sourceQuote: schema.documentItems.sourceQuote })
    .from(schema.documentItems)
    .where(eq(schema.documentItems.documentId, documentId));
  const seen = new Set(existing.map((r) => dedupeKey(r.kind, normalizeWhitespace(r.sourceQuote))));

  let dropped = 0;
  let malformed = 0;
  let duplicates = 0;
  let chunkErrors = 0;
  let lastError = '';
  const pending: (typeof schema.documentItems.$inferInsert)[] = [];

  for (const chunk of chunks) {
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt(chunk.text) },
    ];

    let payload: unknown;
    try {
      payload = await chatJSON(messages);
    } catch (err) {
      // One bad chunk must not lose the other thirty-nine pages. Counted, and promoted to a run
      // error below only when EVERY chunk failed — which is what an unreachable endpoint looks
      // like, and is worth telling the user about.
      chunkErrors++;
      lastError = (err as Error).message;
      continue;
    }

    const raw = parseItems(payload);
    malformed += Math.max(0, rawArray(payload).length - raw.length);

    for (const item of raw) {
      if (pending.length >= MAX_ITEMS_PER_RUN) break;

      // ---- D6. THE GATE. Everything above exists to get here honestly. -------------------
      const verified = verifyQuote(item.sourceQuote, doc);
      if (!verified) {
        dropped++;
        continue;
      }
      // ------------------------------------------------------------------------------------

      // D10: the overlap window means a clause near a chunk boundary is genuinely seen twice, and
      // both calls legitimately return it. Deduping on normalised quote + kind is what makes the
      // overlap free instead of doubling every boundary clause.
      const key = dedupeKey(item.kind, verified.normalized);
      if (seen.has(key)) {
        duplicates++;
        continue;
      }
      seen.add(key);

      pending.push({
        id: nanoid(),
        documentId,
        tabId,
        kind: item.kind,
        text: item.text,
        sourceQuote: verified.quote,
        sourceOffset: verified.offset,
        dueDate: item.dueDate ?? null,
        confidence: item.confidence ?? null,
        status: 'proposed',
        runId: state.runId,
      });
    }
  }

  let proposed = 0;
  try {
    if (pending.length > 0) {
      await db.insert(schema.documentItems).values(pending);
      proposed = pending.length;
    }
  } catch (err) {
    state.status = 'error';
    state.error = `could not store extracted items: ${(err as Error).message}`;
    state.finishedAt = Date.now();
    return;
  }

  const allChunksFailed = chunks.length > 0 && chunkErrors === chunks.length;
  state.status = allChunksFailed ? 'error' : 'done';
  state.error = allChunksFailed ? lastError : undefined;
  state.proposed = proposed;
  state.dropped = dropped;
  state.finishedAt = Date.now();

  recordAudit({
    actorId,
    action: 'document_extract',
    targetType: 'document',
    targetId: documentId,
    scopeId: tabId,
    method: 'POST',
    status: allChunksFailed ? 502 : 200,
    // `dropped` belongs in the audit row and not only in the run state: the run state dies with
    // the process, and the drop rate is the one number that tells an operator the prompt is bad.
    payload: { runId: state.runId, model, chunks: chunks.length, proposed, dropped, duplicates, malformed, chunkErrors },
  });

  // Published here rather than in the route: the route answered 202 minutes ago, and this is the
  // moment at which an open board can usefully refetch.
  publish(boardChannel(tabId), { v: 1, type: 'document', action: 'extracted', documentId, actorId });
}

function dedupeKey(kind: string, normalizedQuote: string): string {
  // Quote AND kind: the same sentence can legitimately be both a deliverable and a date, and
  // collapsing those would silently lose the deadline.
  return `${kind}::${normalizedQuote}`;
}
