// Plain text out of an uploaded file (CONTRACT_TO_PROJECT_PLAN.md D3/D4).
//
// Deliberately pure: bytes in, text out. No database, no bucket, no logging. That is what makes it
// runnable from `npm run verify:extraction` with no infrastructure at all, and it is why the
// route — not this file — owns the decision about when extraction happens.
//
// The interesting decision here is NOT the parsing, it is D4: a PDF that yields almost no text is
// reported as `no_text_layer` rather than `ok`. A scanned contract run through a text extractor
// returns a handful of characters of header junk. Storing that as `ok` means the commitment
// extractor later reads twenty characters of garbage and confidently "finds" obligations in it.
// That is the worst outcome available here — worse than no feature — because someone acts on it.
// Refusing to read a scan is honest; pretending to have read one is not.

/** Why a document has no usable text. Mirrors `documents.text_status` minus `pending`, which is
 *  the row's initial state and never something extraction concludes. */
export type TextStatus = 'ok' | 'no_text_layer' | 'unsupported' | 'too_large' | 'failed';

export interface ExtractResult {
  status: TextStatus;
  /** Only on `ok`. Already normalised and truncated to TEXT_EXTRACT_MAX_CHARS. */
  text?: string;
  chars?: number;
  /** Human-readable reason, for a log line or the UI. Never trusted, never parsed. */
  detail?: string;
}

/**
 * Files above this are not read at all. 25 MiB of text is roughly a 5,000-page contract; past that
 * the file is a scan, a video, or something we have no business loading into a single Buffer —
 * extraction holds the WHOLE file in memory, unlike upload, which streams.
 */
export const TEXT_EXTRACT_MAX_BYTES = Number(process.env.TEXT_EXTRACT_MAX_BYTES ?? 25 * 1024 * 1024);

/** Hard cap on stored text. A Postgres row and an LLM prompt both have opinions about a 50 MB
 *  string; neither of them is polite about it. */
export const TEXT_EXTRACT_MAX_CHARS = Number(process.env.TEXT_EXTRACT_MAX_CHARS ?? 1_000_000);

/**
 * Below this many characters per page, a PDF is treated as a scan (D4).
 *
 * A real contract page is 2,000–4,000 characters. Even a sparse title page clears 100. What lands
 * under it is the extractor scraping a producer string or a stray page number off an image.
 */
const MIN_PDF_CHARS_PER_PAGE = 100;

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Types the sniffer emits when it recognised a container but not its contents. For these — and
 *  only these — the filename extension is allowed to break the tie. */
const GENERIC_MIMES = new Set(['application/octet-stream', 'application/zip']);

const TEXT_EXTENSIONS = new Set([
  'txt', 'text', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'yml', 'yaml', 'rst',
]);

type Kind = 'pdf' | 'docx' | 'text';

/**
 * Which extractor handles this file, or null for "we do not read this type".
 *
 * `filename` is consulted ONLY when the sniffed type is a generic container (see GENERIC_MIMES).
 * That is safe in a way it would not be on the download path: server/lib/mime.ts is deliberately
 * conservative because its answer becomes a Content-Type a browser acts on, whereas extracted text
 * is never served as active content — the worst case of guessing wrong here is a `failed` row.
 */
export function extractorFor(mime: string, filename: string): Kind | null {
  const essence = mime.split(';')[0].trim().toLowerCase();
  if (essence === 'application/pdf') return 'pdf';
  if (essence === DOCX_MIME) return 'docx';
  // application/json is the one non-text/* type that is unambiguously text.
  if (essence.startsWith('text/') || essence === 'application/json') return 'text';
  if (!GENERIC_MIMES.has(essence)) return null;

  const dot = filename.lastIndexOf('.');
  const ext = dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
  if (ext === 'docx') return 'docx';
  return TEXT_EXTENSIONS.has(ext) ? 'text' : null;
}

/** Cheap pre-flight for a caller holding metadata but not yet the bytes. */
export function canExtract(mime: string, filename: string): boolean {
  return extractorFor(mime, filename) !== null;
}

export async function extractText(
  buf: Buffer,
  mime: string,
  filename: string,
): Promise<ExtractResult> {
  if (buf.length > TEXT_EXTRACT_MAX_BYTES) {
    return { status: 'too_large', detail: `${buf.length} bytes, cap is ${TEXT_EXTRACT_MAX_BYTES}` };
  }

  const kind = extractorFor(mime, filename);
  if (!kind) return { status: 'unsupported', detail: mime };

  try {
    if (kind === 'pdf') return await fromPdf(buf);
    if (kind === 'docx') return await fromDocx(buf);
    return fromPlainText(buf);
  } catch (err) {
    // Every parser here is fed hostile input by definition — a user's file. A throw is an expected
    // outcome, not an incident, so it becomes a row status rather than an exception the caller has
    // to think about.
    return { status: 'failed', detail: err instanceof Error ? err.message : String(err) };
  }
}

async function fromPdf(buf: Buffer): Promise<ExtractResult> {
  // Imported lazily: `unpdf` pulls in a PDF.js build, and most instances of this app will never
  // see a PDF. Paying that at first upload rather than at every boot keeps startup honest.
  const { extractText: extractPdfText } = await import('unpdf');

  // A COPY, not the caller's Buffer. PDF.js may take ownership of (and in worker mode transfer)
  // the typed array it is handed, and a Node Buffer is usually a view into a shared allocation
  // pool — detaching it would corrupt whatever else happens to live in that pool.
  const { totalPages, text } = await extractPdfText(new Uint8Array(buf), { mergePages: false });

  const joined = normalise(text.join('\n\n'));
  const pages = Math.max(totalPages, 1);
  if (joined.length < pages * MIN_PDF_CHARS_PER_PAGE) {
    return {
      status: 'no_text_layer',
      chars: joined.length,
      detail: `${joined.length} characters across ${totalPages} page(s) — this is almost certainly a scan`,
    };
  }
  return ok(joined);
}

async function fromDocx(buf: Buffer): Promise<ExtractResult> {
  const mammoth = (await import('mammoth')).default;
  const { value } = await mammoth.extractRawText({ buffer: buf });
  const text = normalise(value);
  // Same reasoning as D4, different container: a Word file of pasted page images parses fine and
  // yields nothing. `no_text_layer` tells the user what is actually wrong; `ok` with zero
  // characters would send them to a "Find commitments" button that can only disappoint.
  if (text.length === 0) return { status: 'no_text_layer', chars: 0, detail: 'the document contains no text' };
  return ok(text);
}

function fromPlainText(buf: Buffer): ExtractResult {
  // A NUL byte is the one thing that never appears in text and always appears in binaries. This is
  // the guard that keeps the extension-based fallback in extractorFor() from storing a megabyte of
  // U+FFFD because someone named a binary `notes.txt`.
  if (buf.includes(0)) return { status: 'unsupported', detail: 'contains NUL bytes; not text' };
  let s = buf.toString('utf8');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1); // BOM, which would otherwise sit inside quote 0
  return ok(normalise(s));
}

function ok(text: string): ExtractResult {
  // Truncation loses the tail of a very long document, which is visible and survivable. The
  // alternative — refusing it — loses all of it.
  const capped = text.length > TEXT_EXTRACT_MAX_CHARS ? text.slice(0, TEXT_EXTRACT_MAX_CHARS) : text;
  return { status: 'ok', text: capped, chars: capped.length };
}

/**
 * Light whitespace tidying, and nothing more.
 *
 * THIS IS LOAD-BEARING FOR SOMETHING ELSE: server/lib/extractItems.ts verifies every model-supplied
 * quote by looking for it inside this exact string (D6, the anti-hallucination gate). Reflowing
 * lines, collapsing runs of spaces, de-hyphenating across line breaks or "fixing" the column
 * artefacts PDF extraction produces would all read better and would all silently break that check —
 * quotes the model copied faithfully would stop matching, and real items would be dropped as
 * hallucinations. So: line endings, form feeds and blank-line runs only. Intra-line spacing is
 * left exactly as the parser produced it.
 */
function normalise(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    // A form feed is a page break. Replaced rather than deleted, so the last word of one page does
    // not weld itself to the first word of the next.
    .replace(/\f/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
