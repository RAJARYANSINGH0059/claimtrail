'use strict';
/** Mocked network for the Sarvam provider. NO real network call is ever made by these tests. */
const KEY = 'sk_test_SECRET_1234567890';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 2)]);
const seenUrls = [];

const json = (status, body, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const kind = (url) => {
  const p = new URL(url).pathname;
  if (p === '/doc-ai/v1/job/digitise') return 'create';
  if (/\/status$/.test(p)) return 'status';
  if (/\/results$/.test(p)) return 'results';
  if (p === '/translate') return 'translate';
  return 'other';
};
/**
 * script: { create: [resp|fn], status: [...], results: [...], translate: [...] }; the last entry repeats.
 * A response entry may be a Response or a function (url, opts) => Response | Promise.
 */
function mockFetch(script) {
  const calls = [];
  const idx = {};
  const fn = async (url, opts = {}) => {
    seenUrls.push(url);
    const k = kind(url);
    calls.push({ kind: k, url, opts });
    const list = script[k] || [];
    const i = Math.min(idx[k] || 0, list.length - 1);
    idx[k] = (idx[k] || 0) + 1;
    const entry = list[i];
    if (entry === undefined) return json(500, { detail: 'no mock configured' });
    return typeof entry === 'function' ? entry(url, opts) : entry.clone();
  };
  fn.calls = calls;
  fn.count = (k) => calls.filter((c) => c.kind === k).length;
  return fn;
}
const JOB = 'job_abc123-XYZ';
const created = (status = 'pending', job_id = JOB) => json(201, { job_id, status, run_id: 'run_1' });
const status = (s, usage) => json(200, { job_id: JOB, status: s, pipeline: 'digitise', usage: usage || { pages_total: 1, pages_processed: 1, pages_succeeded: 1, pages_failed: 0 } });
const results = (pages, extra = {}) => json(200, { job_id: JOB, status: 'completed', usage: { pages_total: pages.length }, documents: [{ file_name: 'x.png', pages }], ...extra });
const page = (n, content) => ({ page_number: n, content });
const noSleep = () => Promise.resolve();
module.exports = { KEY, PNG, PDF, seenUrls, json, mockFetch, JOB, created, status, results, page, noSleep };
