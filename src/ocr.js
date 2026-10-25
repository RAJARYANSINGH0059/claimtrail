'use strict';
/**
 * Local OCR adapter (optional, offline).
 *
 * Reads text from uploaded images and PDFs by calling locally installed command-line tools:
 *   tesseract (images / scanned pages), pdftotext (PDF text layer), pdftoppm (rasterise PDF pages).
 * Nothing is sent over a network: the only thing this file ever spawns is one of those three
 * fixed binaries, via execFile-style spawn (no shell), inside a private temp dir that is
 * removed afterwards. Output is plain text plus a confidence figure; it is NOT a language model.
 *
 * If the tools are missing, or CLAIMTRAIL_OCR=off, the adapter reports `available: false` and the
 * store falls back to the previous behaviour (images/PDFs count as unreadable). Nothing breaks.
 *
 * Honesty rules the rest of the app relies on:
 *  - every page carries `ocr` metadata {method, engine, confidence}; text from OCR is never
 *    presented as a pristine source;
 *  - pages below LOW_CONFIDENCE are rejected as unreadable (text dropped, reason kept);
 *  - pages between LOW_CONFIDENCE and REVIEW_CONFIDENCE are kept but flagged "verify against the image".
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOW_CONFIDENCE = 50;     // below: page rejected as unreadable
const REVIEW_CONFIDENCE = 75;  // below: kept, flagged for human verification
const MIN_TEXT_LAYER_CHARS = 40; // a PDF page with less embedded text than this is OCR'd instead
const TIMEOUT_MS = 30_000;
const MAX_PAGES = 10;          // OCR cost cap per document in this demo
const RENDER_DPI = '200';

let cache = null;
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 8_000_000, shell: false, ...opts });

function detect(force = false) {
  if (cache && !force) return cache;
  if (String(process.env.CLAIMTRAIL_OCR || '').toLowerCase() === 'off') {
    return (cache = { available: false, pdf: false, engine: null, reason: 'Disabled by CLAIMTRAIL_OCR=off.' });
  }
  const t = run('tesseract', ['--version']);
  if (t.error || t.status !== 0) {
    return (cache = { available: false, pdf: false, engine: null, reason: 'Tesseract OCR is not installed on this machine.' });
  }
  const version = (String(t.stdout || t.stderr).split('\n')[0] || 'tesseract').trim();
  const pdf = !run('pdftoppm', ['-v']).error && !run('pdftotext', ['-v']).error;
  return (cache = { available: true, pdf, engine: version, reason: null });
}

/** OCR one image file. Returns { text, confidence } where confidence is the mean word confidence (0-100). */
function ocrFile(file) {
  const r = run('tesseract', [file, 'stdout', '-l', 'eng', '--psm', '6', 'tsv']);
  if (r.error || r.status !== 0) throw new Error('OCR engine failed on this page.');
  const words = [], lines = new Map();
  for (const row of String(r.stdout).split('\n').slice(1)) {
    const c = row.split('\t');
    if (c.length < 12) continue;
    const conf = Number(c[10]); const word = c.slice(11).join('\t').trim();
    if (!word || !(conf >= 0)) continue;
    words.push(conf);
    const key = `${c[2]}-${c[3]}-${c[4]}`;
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key).push(word);
  }
  const text = [...lines.values()].map((w) => w.join(' ')).join('\n');
  const confidence = words.length ? Math.round(words.reduce((a, b) => a + b, 0) / words.length) : 0;
  return { text, confidence };
}

/** Apply the confidence policy to raw OCR output and return the stored page. */
function judge(n, raw, method, engine) {
  const ocr = { method, engine, confidence: raw.confidence, rawChars: raw.text.length, status: 'ok' };
  if (raw.confidence < LOW_CONFIDENCE || !raw.text.trim()) {
    return { n, text: '', ocr: { ...ocr, status: 'rejected_low_confidence' } };
  }
  if (raw.confidence < REVIEW_CONFIDENCE) ocr.status = 'verify';
  return { n, text: raw.text.trim(), ocr };
}

/**
 * Extract pages from an image or PDF buffer.
 * Returns { available, pages, note } and never throws for engine problems (it degrades to one blank page).
 */
function extract(buf, ext, { maxPages = MAX_PAGES } = {}) {
  const info = detect();
  const blank = (note) => ({ available: false, pages: [{ n: 1, text: '', ocr: { method: 'none', engine: null, confidence: null, status: 'unavailable', note } }], note });
  if (!info.available) return blank(info.reason);
  const isPdf = ext === '.pdf';
  if (isPdf && !info.pdf) return blank('PDF tools (pdftotext/pdftoppm) are not installed.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claimtrail-ocr-'));
  try {
    if (!isPdf) {
      const f = path.join(dir, 'page' + ext);
      fs.writeFileSync(f, buf);
      return { available: true, pages: [judge(1, ocrFile(f), 'ocr', info.engine)], note: null };
    }
    const pdf = path.join(dir, 'doc.pdf');
    fs.writeFileSync(pdf, buf);
    const tl = run('pdftotext', ['-layout', '-enc', 'UTF-8', pdf, '-']);
    if (tl.error || tl.status !== 0) return blank('The PDF could not be read (it may be damaged or encrypted).');
    const layers = String(tl.stdout).split('\f');
    if (layers.length && layers[layers.length - 1].trim() === '') layers.pop();
    const total = layers.length;
    if (!total) return blank('The PDF has no pages.');
    const pages = [];
    for (let i = 0; i < Math.min(total, maxPages); i++) {
      const layer = layers[i].trim();
      if (layer.length >= MIN_TEXT_LAYER_CHARS) {
        pages.push({ n: i + 1, text: layer, ocr: { method: 'pdf-text-layer', engine: 'pdftotext', confidence: null, status: 'ok' } });
        continue;
      }
      const prefix = path.join(dir, `p${i + 1}`);
      const rr = run('pdftoppm', ['-r', RENDER_DPI, '-f', String(i + 1), '-l', String(i + 1), '-png', '-singlefile', pdf, prefix]);
      if (rr.error || rr.status !== 0 || !fs.existsSync(prefix + '.png')) {
        pages.push({ n: i + 1, text: '', ocr: { method: 'ocr', engine: info.engine, confidence: null, status: 'failed' } });
        continue;
      }
      pages.push(judge(i + 1, ocrFile(prefix + '.png'), 'ocr', info.engine));
    }
    // Pages beyond the cap are kept as unreadable placeholders so page numbers stay truthful.
    for (let i = maxPages; i < total; i++) pages.push({ n: i + 1, text: '', ocr: { method: 'none', engine: null, confidence: null, status: 'skipped_page_cap' } });
    return { available: true, pages, note: total > maxPages ? `Only the first ${maxPages} of ${total} pages were read (demo cap).` : null };
  } catch (e) {
    return blank('OCR failed: ' + String(e.message).slice(0, 120));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const status = () => {
  const i = detect();
  return { available: i.available, pdf: i.pdf, engine: i.engine, reason: i.reason, lowConfidence: LOW_CONFIDENCE, reviewConfidence: REVIEW_CONFIDENCE, isModel: false };
};

module.exports = { detect, extract, status, judge, LOW_CONFIDENCE, REVIEW_CONFIDENCE, MAX_PAGES };
