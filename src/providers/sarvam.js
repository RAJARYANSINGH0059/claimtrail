'use strict';
/**
 * Sarvam AI provider (server-side only). THE ONLY FILE ALLOWED TO MAKE AN OUTBOUND NETWORK CALL.
 *
 * Contract checked against the official reference on 2026-10-25 (sources and the exact verified/unverified split are in
 * docs/SARVAM_INTEGRATION.md):
 *   host    https://api.sarvam.ai                              (fixed constant, never user/model supplied)
 *   auth    header `api-subscription-key: <key>`               (403 = missing/invalid key)
 *   digitise  POST /doc-ai/v1/job/digitise   multipart: file, language, content_type  -> {job_id,status,run_id}
 *   status    GET  /doc-ai/v1/job/{job_id}/status              -> {status, usage:{pages_*}}
 *             states: pending, running | terminal: completed, partially_completed, failed, rejected
 *   results   GET  /doc-ai/v1/job/{job_id}/results?format=md   -> envelope {job_id,type,status,usage,documents} is documented;
 *             the per-page shape inside `documents` is NOT documented by Sarvam, so it is parsed defensively (see normalise)
 *             and must be confirmed once with a live key: `npm run sarvam:smoke` (opt-in; prints structure only).
 *   translate POST /translate  JSON {input, source_language_code, target_language_code, model, mode, numerals_format}
 *
 * Safety properties (all covered by test/sarvam.test.js with a mocked fetch):
 *  - no key, no call; the key is only ever placed in the request header;
 *  - job ids are validated before they are put in a URL path; redirects are refused;
 *  - every request has a timeout; polling is bounded by count AND wall-clock; the paid create call is never retried;
 *  - vendor error bodies/messages are never copied into our errors (they could contain URLs or content);
 *  - results are schema-validated; page numbers come from the provider or the result is rejected;
 *  - confidence is never invented: Document AI digitise supplies none, so it is reported as null.
 */
const BASE = 'https://api.sarvam.ai';
const OFFICIAL_HOST = 'api.sarvam.ai';
const PATHS = {
  digitise: '/doc-ai/v1/job/digitise',
  status: (id) => `/doc-ai/v1/job/${encodeURIComponent(id)}/status`,
  results: (id) => `/doc-ai/v1/job/${encodeURIComponent(id)}/results`,
  translate: '/translate',
};
const LANGS = new Set(['en-IN', 'hi-IN', 'bn-IN', 'ta-IN', 'te-IN', 'mr-IN', 'gu-IN', 'kn-IN', 'ml-IN', 'od-IN', 'pa-IN', 'as-IN', 'brx-IN', 'doi-IN', 'ks-IN', 'kok-IN', 'mai-IN', 'mni-IN', 'ne-IN', 'sa-IN', 'sat-IN', 'sd-IN', 'ur-IN']);
const INPUT_TYPES = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const TERMINAL_OK = new Set(['completed', 'partially_completed']);
const TERMINAL_BAD = new Set(['failed', 'rejected']);
const PENDING = new Set(['pending', 'running']);
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const DEFAULT_LIMITS = {
  requestTimeoutMs: 30_000, pollIntervalMs: 2_000, maxPolls: 30, totalDeadlineMs: 90_000,
  maxTransientPollErrors: 3, maxBytes: 1_000_000, maxPages: 10, maxResponseBytes: 5_000_000,
  maxPageChars: 20_000, translateTimeoutMs: 20_000, maxTranslateChars: 2_000,
};

/** Error with a stable code and a SAFE message. `status` is the HTTP status ClaimTrail returns to its own client. */
class SarvamError extends Error {
  constructor(code, message, status = 502) { super(message); this.name = 'SarvamError'; this.code = code; this.status = status; }
}
const E = {
  auth: () => new SarvamError('SARVAM_AUTH', 'Sarvam rejected the server\'s API key. The operator must check SARVAM_API_KEY.', 502),
  billing: () => new SarvamError('SARVAM_BILLING', 'Sarvam reported a billing or entitlement problem for this key.', 502),
  badRequest: () => new SarvamError('SARVAM_BAD_REQUEST', 'Sarvam could not accept this document or setting (for example more than 10 pages or an unsupported language).', 422),
  notFound: () => new SarvamError('SARVAM_NOT_FOUND', 'Sarvam could not find the analysis job.', 502),
  conflict: () => new SarvamError('SARVAM_CONFLICT', 'Sarvam reported the results are not ready yet.', 502),
  tooLarge: () => new SarvamError('SARVAM_TOO_LARGE', 'Sarvam rejected the file as too large.', 413),
  unprocessable: () => new SarvamError('SARVAM_UNPROCESSABLE', 'Sarvam could not read this file; it may be corrupted or an unsupported type.', 422),
  rate: () => new SarvamError('SARVAM_RATE_LIMITED', 'Sarvam is rate-limiting requests. Try again later.', 429),
  unavailable: () => new SarvamError('SARVAM_UNAVAILABLE', 'Sarvam is temporarily unavailable.', 503),
  timeout: () => new SarvamError('SARVAM_TIMEOUT', 'Sarvam did not answer in time.', 504),
  pollLimit: () => new SarvamError('SARVAM_POLL_LIMIT', 'The analysis took longer than the demo allows and was abandoned. The remote job may still finish on Sarvam\'s side.', 504),
  jobFailed: (s) => new SarvamError('SARVAM_JOB_FAILED', `Sarvam could not process this document (job ${s}).`, 422),
  invalid: (why) => new SarvamError('SARVAM_INVALID_RESPONSE', `Sarvam returned a response ClaimTrail could not safely use (${why}). Nothing was added to the case.`, 502),
  cancelled: () => new SarvamError('SARVAM_CANCELLED', 'The analysis was cancelled.', 409),
  badInput: (m) => new SarvamError('INPUT_INVALID', m, 422),
};
const byHttp = (status) => {
  if (status === 400) return E.badRequest();
  if (status === 401 || status === 403) return E.auth();
  if (status === 402) return E.billing();
  if (status === 404) return E.notFound();
  if (status === 409) return E.conflict();
  if (status === 413) return E.tooLarge();
  if (status === 422) return E.unprocessable();
  if (status === 429) return E.rate();
  if (status >= 500) return E.unavailable();
  return E.invalid(`HTTP ${status}`);
};

/** Convert provider markdown/HTML into plain text. The UI only ever renders it with textContent. */
function plainText(content, maxChars = DEFAULT_LIMITS.maxPageChars) {
  let t = String(content == null ? '' : content);
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'); // drop URLs (could be signed)
  t = t.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n').replace(/<\/(td|th)>/gi, '  ').replace(/<[^>]*>/g, ' ');
  t = t.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  t = t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  const lines = [];
  for (let line of t.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)) continue; // table separator row
    if (/^\s*\|.*\|\s*$/.test(line)) line = line.trim().slice(1, -1).split('|').map((c) => c.trim()).join('  ');
    line = line.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/^\s{0,3}>\s?/, '').replace(/(\*\*|__)(.*?)\1/g, '$2').replace(/`([^`]*)`/g, '$1');
    lines.push(line.replace(/[ \t]+$/g, ''));
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxChars);
}

function createSarvamProvider({ apiKey, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), limits = {}, now = () => Date.now() } = {}) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  const configured = typeof apiKey === 'string' && apiKey.trim().length >= 8 && typeof fetchImpl === 'function';

  async function call(path, { method = 'GET', body, headers = {}, timeoutMs = L.requestTimeoutMs, signal } = {}) {
    if (!configured) throw new SarvamError('SARVAM_NOT_CONFIGURED', 'Sarvam is not configured on this server.', 503);
    const url = new URL(BASE + path);
    if (url.hostname !== OFFICIAL_HOST || url.protocol !== 'https:') throw E.invalid('unexpected host'); // defence in depth
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (signal) { if (signal.aborted) throw E.cancelled(); signal.addEventListener('abort', onAbort, { once: true }); }
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url.href, { method, headers: { 'api-subscription-key': apiKey, Accept: 'application/json', ...headers }, body, signal: ac.signal, redirect: 'error' });
      return res;
    } catch (e) {
      if (signal && signal.aborted) throw E.cancelled();
      throw ac.signal.aborted ? E.timeout() : E.unavailable();
    } finally { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); }
  }

  async function readJson(res) {
    const len = Number(res.headers && res.headers.get ? res.headers.get('content-length') : 0);
    if (len > L.maxResponseBytes) throw E.invalid('response too large');
    let text;
    try { text = await res.text(); } catch { throw E.invalid('unreadable body'); }
    if (text.length > L.maxResponseBytes) throw E.invalid('response too large');
    try { const v = JSON.parse(text); if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('shape'); return v; } catch { throw E.invalid('not a JSON object'); }
  }

  const sanitizeName = (n) => String(n || 'document').replace(/[^\p{L}\p{N} ._()-]/gu, '_').slice(0, 80) || 'document';
  const extOf = (n) => { const m = /\.[A-Za-z0-9]+$/.exec(String(n || '')); return m ? m[0].toLowerCase() : ''; };

  function checkMagic(bytes, ext) {
    const starts = (...b) => b.every((x, i) => bytes[i] === x);
    if (ext === '.pdf') return starts(0x25, 0x50, 0x44, 0x46, 0x2d);
    if (ext === '.png') return starts(0x89, 0x50, 0x4e, 0x47);
    return starts(0xff, 0xd8, 0xff);
  }

  /** Digitise one document and return normalised pages. Never throws anything but SarvamError. */
  async function digitise({ name, bytes, language = 'en-IN', contentType = 'printed', signal, onRaw } = {}) {
    const ext = extOf(name);
    if (!INPUT_TYPES[ext]) throw E.badInput('Sarvam Document AI accepts PDF, PNG and JPG files only.');
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw E.badInput('The file is empty.');
    if (bytes.length > L.maxBytes) throw E.badInput(`The file is larger than the ${L.maxBytes / 1000} KB demo limit.`);
    if (!checkMagic(bytes, ext)) throw E.badInput(`The file does not look like a real ${ext} file.`);
    if (!LANGS.has(language)) throw E.badInput('Unsupported document language code.');
    if (!['printed', 'handwritten', 'mixed'].includes(contentType)) throw E.badInput('Unsupported content type.');

    const form = new FormData();
    form.append('file', new Blob([bytes], { type: INPUT_TYPES[ext] }), sanitizeName(name));
    form.append('language', language);
    form.append('content_type', contentType);
    // NOTE: the create call is paid and is deliberately NOT retried.
    const created = await call(PATHS.digitise, { method: 'POST', body: form, signal });
    if (created.status !== 200 && created.status !== 201) throw byHttp(created.status);
    const job = await readJson(created);
    const jobId = job.job_id;
    if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) throw E.invalid('bad job id');

    const started = now();
    let transient = 0, usage = null, status = typeof job.status === 'string' ? job.status : 'pending';
    for (let polls = 0; !TERMINAL_OK.has(status) && !TERMINAL_BAD.has(status); polls++) {
      if (polls >= L.maxPolls || now() - started > L.totalDeadlineMs) throw E.pollLimit();
      await sleep(L.pollIntervalMs);
      if (signal && signal.aborted) throw E.cancelled();
      let res;
      try { res = await call(PATHS.status(jobId), { signal }); } catch (e) {
        if (e.code === 'SARVAM_TIMEOUT' || e.code === 'SARVAM_UNAVAILABLE') { if (++transient > L.maxTransientPollErrors) throw e; continue; }
        throw e;
      }
      if (res.status === 429 || res.status >= 500) { if (++transient > L.maxTransientPollErrors) throw byHttp(res.status); continue; }
      if (res.status !== 200) throw byHttp(res.status);
      const body = await readJson(res);
      if (typeof body.status !== 'string') throw E.invalid('missing status');
      if (!PENDING.has(body.status) && !TERMINAL_OK.has(body.status) && !TERMINAL_BAD.has(body.status)) throw E.invalid('unknown job state');
      status = body.status; usage = body.usage;
      transient = 0;
    }
    if (TERMINAL_BAD.has(status)) throw E.jobFailed(status);

    const rr = await call(`${PATHS.results(jobId)}?format=md`, { signal });
    if (rr.status !== 200) throw byHttp(rr.status);
    const out = await readJson(rr);
    if (typeof onRaw === 'function') onRaw(out); // used ONLY by scripts/sarvam-smoke.js to print the response STRUCTURE
    return normalise(out, { jobId, ext, status, usage: usage || out.usage, language });
  }

  /** Validate the provider result and map it to ClaimTrail pages. Rejects instead of coercing. */
  function normalise(out, { jobId, ext, status, usage, language }) {
    if (out.job_id !== undefined && out.job_id !== jobId) throw E.invalid('job id mismatch');
    if (!Array.isArray(out.documents) || out.documents.length < 1) throw E.invalid('no documents');
    const doc = out.documents[0];
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.pages) || doc.pages.length > L.maxPages) throw E.invalid('bad pages');
    const isImage = ext !== '.pdf';
    const seen = new Set();
    const pages = [];
    for (const [i, p] of doc.pages.entries()) {
      if (!p || typeof p !== 'object') throw E.invalid('bad page');
      // Sarvam's reference documents the envelope (job_id, type, status, usage, documents) but NOT the per-page shape
      // inside `documents`. Accept only this explicit list of names; anything else is rejected, never guessed.
      let n = p.page_number !== undefined ? p.page_number : p.page_num; // page_num is the name Sarvam uses in extract `sources`
      if (n === undefined && isImage && doc.pages.length === 1) n = 1; // a single image is page 1 by definition
      if (!Number.isInteger(n) || n < 1 || n > 1000 || seen.has(n)) throw E.invalid('missing or invalid page number');
      const key = ['content', 'markdown', 'text'].find((k) => p[k] !== undefined);
      if (key !== undefined && typeof p[key] !== 'string') throw E.invalid('bad page content');
      seen.add(n);
      pages.push({ n, text: plainText(key === undefined ? '' : p[key]) });
    }
    pages.sort((a, b) => a.n - b.n);
    const u = {};
    for (const k of ['pages_total', 'pages_processed', 'pages_succeeded', 'pages_failed']) if (usage && Number.isInteger(usage[k]) && usage[k] >= 0 && usage[k] <= 1000) u[k] = usage[k];
    // partially_completed: pages the provider did not return stay visible as EMPTY (unreadable) pages, never invented.
    const partial = status === 'partially_completed';
    let full = pages;
    if (partial && Number.isInteger(u.pages_total) && u.pages_total >= pages.length && u.pages_total <= L.maxPages) {
      full = [];
      for (let n = 1; n <= u.pages_total; n++) full.push(pages.find((p) => p.n === n) || { n, text: '' });
    }
    if (!full.length) throw E.invalid('empty result');
    if (full.some((p, i) => p.n !== i + 1) && !partial) throw E.invalid('non-consecutive page numbers');
    return {
      jobId, partial, usage: u, language,
      pages: full.map((p) => ({ n: p.n, text: p.text, ocr: { method: 'sarvam-document-ai', engine: 'Sarvam Document AI', confidence: null, status: 'verify', jobId, rawChars: p.text.length } })),
    };
  }

  /** Translate text with Sarvam Translate (sarvam-translate:v1, formal). Returns { translatedText }. */
  async function translate({ text, source = 'en-IN', target = 'hi-IN', signal } = {}) {
    if (typeof text !== 'string' || !text.trim()) throw E.badInput('There is nothing to translate.');
    if (text.length > L.maxTranslateChars) throw E.badInput(`Text is limited to ${L.maxTranslateChars} characters per translation.`);
    if (!LANGS.has(source) || !LANGS.has(target) || source === target) throw E.badInput('Unsupported or identical language codes.');
    const res = await call(PATHS.translate, {
      method: 'POST', timeoutMs: L.translateTimeoutMs, signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text, source_language_code: source, target_language_code: target, model: 'sarvam-translate:v1', mode: 'formal', numerals_format: 'international' }),
    });
    if (res.status !== 200) throw byHttp(res.status);
    const body = await readJson(res);
    if (typeof body.translated_text !== 'string' || !body.translated_text.trim() || body.translated_text.length > L.maxTranslateChars * 4) throw E.invalid('bad translation');
    return { translatedText: body.translated_text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '') };
  }

  return { configured, digitise, translate, limits: L };
}

/** Structure-only description of a value (types and lengths, never content). */
function describeShape(v, depth = 0) {
  if (Array.isArray(v)) return depth > 4 ? 'array' : { array: v.length, first: v.length ? describeShape(v[0], depth + 1) : null };
  if (v && typeof v === 'object') return depth > 4 ? 'object' : Object.fromEntries(Object.keys(v).slice(0, 30).map((k) => [k, describeShape(v[k], depth + 1)]));
  return typeof v === 'string' ? `string(${v.length})` : typeof v;
}

module.exports = { describeShape, createSarvamProvider, SarvamError, plainText, BASE, OFFICIAL_HOST, LANGS, INPUT_TYPES, DEFAULT_LIMITS };
