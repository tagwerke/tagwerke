// Content-type sniffing for uploaded files (DOCUMENTS_PLAN.md §5.3).
//
// The client's declared Content-Type is never used. It decides what we later hand back in a
// download's Content-Type header, and a lie there is the classic route from "upload" to "stored
// XSS": claim text/html, get it rendered on this origin, run script with the viewer's session
// cookie. So the type is derived from the bytes, and anything not positively recognised goes out as
// application/octet-stream.
//
// This is an ALLOWLIST, not a detector: the goal is not to identify every format, it is to never
// label something as a type a browser will treat as active content. SVG and HTML are recognisable
// and still deliberately absent — both are scriptable, and there is no version of serving them
// inline that is worth the risk. They download as octet-stream, which is the correct outcome.
//
// Defence in depth, not the only defence: downloads also carry Content-Disposition: attachment and
// the app-wide X-Content-Type-Options: nosniff from P0.

export const FALLBACK_MIME = 'application/octet-stream';

/** How many leading bytes the sniffer needs. 4 KiB is plenty for magic numbers and a text sample. */
export const SNIFF_BYTES = 4096;

function starts(buf: Buffer, sig: number[], offset = 0): boolean {
  if (buf.length < offset + sig.length) return false;
  return sig.every((b, i) => buf[offset + i] === b);
}

/**
 * Best-effort type for `head` (the first SNIFF_BYTES of the file).
 *
 * `filename` is consulted ONLY to pick between types that share a signature — the ZIP container
 * behind .docx/.xlsx/.pptx is byte-identical to a plain .zip, and telling them apart properly means
 * parsing [Content_Types].xml inside the archive. The extension cannot promote a file to a type the
 * bytes do not support, so a hostile name buys nothing.
 */
export function sniffMime(head: Buffer, filename: string): string {
  // ---- images ----
  if (starts(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts(head, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts(head, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (starts(head, [0x52, 0x49, 0x46, 0x46]) && starts(head, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';

  // ---- documents ----
  if (starts(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'; // %PDF-

  // ---- zip container, and the Office formats built on it ----
  if (starts(head, [0x50, 0x4b, 0x03, 0x04]) || starts(head, [0x50, 0x4b, 0x05, 0x06])) {
    const ext = extensionOf(filename);
    if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (ext === 'xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if (ext === 'pptx') return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    return 'application/zip';
  }

  // ---- media ----
  if (starts(head, [0x66, 0x74, 0x79, 0x70], 4)) return 'video/mp4';
  if (starts(head, [0x49, 0x44, 0x33])) return 'audio/mpeg';

  // ---- plain text, by elimination ----
  // No magic number exists, so this is the one heuristic here: valid UTF-8 with no control bytes
  // outside the usual whitespace. text/plain is safe to serve — unlike text/html, it is inert.
  if (head.length > 0 && isProbablyText(head)) return 'text/plain; charset=utf-8';

  return FALLBACK_MIME;
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

function isProbablyText(buf: Buffer): boolean {
  // A byte scan, not a UTF-8 decode: the sample is cut at a fixed 4 KiB boundary, so a multi-byte
  // character is very likely sliced in half and a strict decode would reject perfectly good text.
  for (const byte of buf) {
    // NUL and most C0 controls never appear in text; tab/LF/CR/FF do.
    if (byte === 0) return false;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) return false;
  }
  return true;
}

/**
 * A filename safe to put in a Content-Disposition header.
 *
 * Two jobs: keep path separators out (a name is never a path), and keep quotes and control
 * characters out so the header cannot be split or its quoting escaped. Callers pair the ASCII
 * fallback this returns with an RFC 5987 `filename*` for the real, possibly non-ASCII name.
 */
export function safeFilename(filename: string): string {
  const base = filename.replace(/[\\/]/g, '_');
  // Filter by code point rather than a regex: control characters (a CR or LF would split the
  // header) and the double quote that delimits the filename= value both have to go, and writing
  // them as literal bytes in a character class is invisible to anyone reading this later.
  const stripped = Array.from(base)
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code > 0x1f && code !== 0x7f && ch !== '"';
    })
    .join('')
    .trim();
  return stripped.slice(0, 200) || 'download';
}
