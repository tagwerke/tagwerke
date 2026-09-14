// Asserts what server/lib/textExtract.ts does with each kind of file
// (CONTRACT_TO_PROJECT_PLAN.md §1 D3/D4, §7).
//
// Needs NOTHING: no database, no bucket, no network. Extraction is a pure function, so this script
// builds every fixture in memory — which also means there are no binary test files in the repo for
// someone to wonder about later.
//
//   npm run verify:extraction
//
// The case that matters most is `no_text_layer`. Everything else here fails loudly on its own; a
// broken scan check fails SILENTLY, by returning twenty characters of header junk as if it were a
// contract. Whatever else changes in that file, keep that case.

import JSZip from 'jszip';
import { extractText, TEXT_EXTRACT_MAX_BYTES } from '../lib/textExtract.ts';

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

const PDF_MIME = 'application/pdf';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Long enough to clear the 100-characters-per-page scan threshold on a one-page document, which is
// the whole point: a fixture that only just failed would make the D4 check untestable.
const CONTRACT_LINES = [
  'Agency shall deliver three (3) initial brand identity concepts within thirty days.',
  'Excluded from this Agreement: print production, media buying and translation.',
  'Client is entitled to up to two (2) rounds of revision per deliverable.',
];

// ---- fixtures ----------------------------------------------------------------

/**
 * A real, structurally valid PDF, assembled from a list of object bodies.
 *
 * PDF is a plain-text container, so this is a few hundred bytes rather than a checked-in binary.
 * The xref offsets are computed for real instead of faked: PDF.js *can* reconstruct a broken xref,
 * but it does so with warnings and a different code path, and a fixture that quietly exercises the
 * recovery path is not testing what this script claims to test. `latin1` keeps one char = one byte
 * so the offsets are honest.
 */
function buildPdf(objects: string[]): Buffer {
  const header = '%PDF-1.4\n';
  const offsets: number[] = [];
  let body = '';
  objects.forEach((obj, i) => {
    offsets.push(header.length + body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });

  const startxref = header.length + body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;

  return Buffer.from(header + body + xref + trailer, 'latin1');
}

function stream(content: string): string {
  return `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
}

function onePagePdf(content: string, withFont: boolean): Buffer {
  const resources = withFont ? '/Resources << /Font << /F1 4 0 R >> >> ' : '/Resources << >> ';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ${resources}/Contents 5 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    stream(content),
  ];
  return buildPdf(objects);
}

/** A PDF with a genuine text layer: one Tj per line of the contract. */
function textPdf(): Buffer {
  const ops = CONTRACT_LINES.map(
    (line, i) => `BT /F1 11 Tf 72 ${720 - i * 20} Td (${line.replace(/([()\\])/g, '\\$1')}) Tj ET`,
  ).join('\n');
  return onePagePdf(ops, true);
}

/**
 * A PDF that draws marks but contains no text — which is exactly what a scan is: one big image
 * operator per page and not a character of it readable.
 */
function scannedPdf(): Buffer {
  return onePagePdf('0.5 0.5 0.5 rg\n50 50 500 700 re\nf', false);
}

/**
 * The smallest thing mammoth will accept as a .docx. The relationship and content-type parts are
 * included even though mammoth falls back to `word/document.xml` without them, so the fixture is a
 * real OOXML package rather than something that happens to satisfy one library.
 */
async function docx(paragraphs: string[]): Promise<Buffer> {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`)
    .join('');
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      `<Override PartName="/word/document.xml" ContentType="${DOCX_MIME}.main+xml"/>` +
      '</Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Target="word/document.xml" ' +
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"/>' +
      '</Relationships>',
  );
  zip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${body}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

// ---- the run -----------------------------------------------------------------

console.log('\nplain text:');
{
  const source = `${CONTRACT_LINES.join('\n')}\n`;
  const r = await extractText(Buffer.from(source, 'utf8'), 'text/plain; charset=utf-8', 'terms.txt');
  check('status is ok', r.status === 'ok', r);
  check('the text survives', r.text?.includes(CONTRACT_LINES[0]) === true, r.text);
  check('chars matches the text length', r.chars === r.text?.length, { chars: r.chars });
}

console.log('\nplain text — normalisation is light on purpose:');
{
  // Quote verification (D6) matches model output against this exact string by substring. Anything
  // that reflowed lines or squeezed spaces would break it, so this asserts what must NOT happen.
  const source = 'Clause  one   spaced.\r\n\r\n\r\n\r\nClause two.\fClause three.';
  const r = await extractText(Buffer.from(source, 'utf8'), 'text/plain', 'odd.txt');
  check('CRLF becomes LF', r.text?.includes('\r') === false, r.text);
  check('runs of blank lines collapse to one', r.text?.includes('\n\n\n') === false, r.text);
  check('a form feed becomes a break, not a join', r.text?.includes('Clause two.\nClause three.') === true, r.text);
  check('intra-line spacing is left alone', r.text?.includes('Clause  one   spaced.') === true, r.text);
}

console.log('\nDOCX:');
{
  const r = await extractText(await docx(CONTRACT_LINES), DOCX_MIME, 'msa.docx');
  check('status is ok', r.status === 'ok', r);
  check('every paragraph is present', CONTRACT_LINES.every((l) => r.text?.includes(l)), r.text);
}

console.log('\nDOCX with no text at all (a Word file of pasted images):');
{
  const r = await extractText(await docx([]), DOCX_MIME, 'scan.docx');
  check('reports no_text_layer, not ok', r.status === 'no_text_layer', r);
}

console.log('\nPDF with a real text layer:');
{
  const r = await extractText(textPdf(), PDF_MIME, 'msa.pdf');
  check('status is ok', r.status === 'ok', { status: r.status, detail: r.detail });
  check('the first clause is readable', r.text?.includes('three (3) initial brand identity concepts') === true, r.text);
  check('the exclusion is readable', r.text?.includes('print production') === true, r.text);
}

console.log('\nPDF with NO text layer — the case that must never be silent (D4):');
{
  const r = await extractText(scannedPdf(), PDF_MIME, 'signed-scan.pdf');
  check('reports no_text_layer', r.status === 'no_text_layer', r);
  check('stores no text', r.text === undefined, r.text);
  check('says why', typeof r.detail === 'string' && r.detail.length > 0, r.detail);
}

console.log('\nunsupported types:');
{
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const r = await extractText(png, 'image/png', 'signature.png');
  check('an image is unsupported', r.status === 'unsupported', r);
  const zip = await extractText(await docx(CONTRACT_LINES), 'application/zip', 'bundle.zip');
  check('a plain zip is unsupported', zip.status === 'unsupported', zip.status);
  // The extension fallback only reaches generic container types, and a NUL byte overrules it.
  const fake = await extractText(Buffer.from([0x41, 0x00, 0x42]), 'application/octet-stream', 'notes.txt');
  check('a binary named .txt is unsupported, not garbage text', fake.status === 'unsupported', fake);
}

console.log('\nsize cap:');
{
  const over = Buffer.alloc(TEXT_EXTRACT_MAX_BYTES + 1, 0x41);
  const r = await extractText(over, 'text/plain', 'huge.txt');
  check('over the cap reports too_large', r.status === 'too_large', r.status);
  check('and reads nothing', r.text === undefined);
}

console.log('\ncorrupt input:');
{
  // Looks like a PDF to the sniffer, is not one. PDF.js throws; extractText must absorb it.
  const broken = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048, 0x41)]);
  let threw = false;
  let r;
  try {
    r = await extractText(broken, PDF_MIME, 'broken.pdf');
  } catch {
    threw = true;
  }
  check('does not throw at the caller', !threw);
  check('reports failed', r?.status === 'failed', r);
  check('carries the library message', typeof r?.detail === 'string' && r.detail.length > 0, r?.detail);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.\n`);
  process.exit(1);
}
console.log('\nall text extraction checks passed.\n');
process.exit(0);
