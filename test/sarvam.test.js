'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSarvamProvider, SarvamError, plainText, OFFICIAL_HOST } = require('../src/providers/sarvam');
const H = require('./helpers-sarvam');
const { KEY, PNG, PDF, json, mockFetch, JOB, created, status, results, page, noSleep } = H;

const mk = (script, limits = {}, extra = {}) => {
  const f = mockFetch(script);
  return { f, p: createSarvamProvider({ apiKey: KEY, fetchImpl: f, sleep: noSleep, limits: { pollIntervalMs: 0, ...limits }, ...extra }) };
};
const rejectsWith = async (promise, code) => {
  try { await promise; } catch (e) {
    assert.ok(e instanceof SarvamError, `expected SarvamError, got ${e && e.name}: ${e && e.message}`);
    assert.equal(e.code, code, `expected ${code} got ${e.code}`);
    return e;
  }
  assert.fail(`expected rejection with ${code}`);
};
const ok = (n = 1) => ({ create: [created()], status: [status('completed')], results: [results(Array.from({ length: n }, (_, i) => page(i + 1, `Page ${i + 1} text`)))] });

test('no key, or no fetch: provider is not configured and makes no network call', async () => {
  const f = mockFetch(ok());
  for (const apiKey of [undefined, '', '   ', 'short']) {
    const p = createSarvamProvider({ apiKey, fetchImpl: f });
    assert.equal(p.configured, false);
    await rejectsWith(p.digitise({ name: 'a.png', bytes: PNG }), 'SARVAM_NOT_CONFIGURED');
    await rejectsWith(p.translate({ text: 'hello' }), 'SARVAM_NOT_CONFIGURED');
  }
  assert.equal(f.calls.length, 0);
});

test('happy path: documented auth header, multipart payload, pending -> running -> completed, normalised output', async () => {
  const { f, p } = mk({
    create: [created('pending')],
    status: [status('pending'), status('running'), status('completed')],
    results: [results([page(1, '# CASH MEMO\n\n**Patient Name:** Aarav Mehta\n| Item | Amt |\n|---|---|\n| ORS | ₹ 150 |\nTotal amount: 1,000')])],
  });
  const r = await p.digitise({ name: 'bill scan.png', bytes: PNG, language: 'hi-IN' });
  const create = f.calls.find((c) => c.kind === 'create');
  assert.equal(create.opts.method, 'POST');
  assert.equal(create.opts.headers['api-subscription-key'], KEY);
  assert.equal(create.opts.redirect, 'error', 'redirects are refused');
  assert.ok(create.opts.body instanceof FormData);
  assert.equal(create.opts.body.get('language'), 'hi-IN');
  assert.equal(create.opts.body.get('content_type'), 'printed');
  const file = create.opts.body.get('file');
  assert.equal(file.type, 'image/png');
  assert.equal(file.name, 'bill scan.png');
  assert.equal(new URL(create.url).pathname, '/doc-ai/v1/job/digitise');
  assert.deepEqual(f.calls.filter((c) => c.kind === 'status').map((c) => new URL(c.url).pathname), [`/doc-ai/v1/job/${JOB}/status`, `/doc-ai/v1/job/${JOB}/status`, `/doc-ai/v1/job/${JOB}/status`]);
  const res = f.calls.find((c) => c.kind === 'results');
  assert.equal(res.url, `https://api.sarvam.ai/doc-ai/v1/job/${JOB}/results?format=md`);
  assert.equal(res.opts.headers['api-subscription-key'], KEY);
  assert.equal(r.jobId, JOB);
  assert.equal(r.partial, false);
  assert.equal(r.pages.length, 1);
  assert.equal(r.pages[0].n, 1);
  assert.match(r.pages[0].text, /Patient Name: Aarav Mehta/);
  assert.match(r.pages[0].text, /ORS {2}₹ 150/);
  assert.doesNotMatch(r.pages[0].text, /\*\*|\|---|#/);
  assert.deepEqual(r.pages[0].ocr, { method: 'sarvam-document-ai', engine: 'Sarvam Document AI', confidence: null, status: 'verify', jobId: JOB, rawChars: r.pages[0].text.length });
});

test('confidence is never invented: it is null (not supplied) even if the provider sends a number elsewhere', async () => {
  const { p } = mk({ create: [created()], status: [status('completed')], results: [results([{ page_number: 1, content: 'Total 5', confidence: 0.99 }])] });
  const r = await p.digitise({ name: 'a.png', bytes: PNG });
  assert.equal(r.pages[0].ocr.confidence, null);
});

test('input validation happens before any network call: type, empty, size, magic bytes, language, content type', async () => {
  const { f, p } = mk(ok(), { maxBytes: 100 });
  await rejectsWith(p.digitise({ name: 'a.txt', bytes: PNG }), 'INPUT_INVALID');
  await rejectsWith(p.digitise({ name: 'a.exe', bytes: PNG }), 'INPUT_INVALID');
  await rejectsWith(p.digitise({ name: 'a.png', bytes: new Uint8Array(0) }), 'INPUT_INVALID');
  await rejectsWith(p.digitise({ name: 'a.png', bytes: Buffer.alloc(101, 0x89) }), 'INPUT_INVALID');
  await rejectsWith(p.digitise({ name: 'a.png', bytes: Buffer.from('not a png at all') }), 'INPUT_INVALID');
  await rejectsWith(p.digitise({ name: 'a.pdf', bytes: PNG }), 'INPUT_INVALID');
  await rejectsWith(p.digitise({ name: 'a.png', bytes: PNG, language: 'xx-YY' }), 'INPUT_INVALID');
  await rejectsWith(p.digitise({ name: 'a.png', bytes: PNG, language: '../../evil' }), 'INPUT_INVALID');
  await rejectsWith(p.digitise({ name: 'a.png', bytes: PNG, contentType: 'x' }), 'INPUT_INVALID');
  await rejectsWith(p.digitise({ name: 'a.png', bytes: 'string-not-bytes' }), 'INPUT_INVALID');
  assert.equal(f.calls.length, 0);
});

test('malformed job ids are rejected before they can reach a URL path', async () => {
  for (const bad of ['../etc/passwd', 'a/b', 'a b', '', 123, null, 'x'.repeat(200), 'job?x=1', 'job#1', '%2e%2e']) {
    const { f, p } = mk({ create: [created('pending', bad)] });
    await rejectsWith(p.digitise({ name: 'a.png', bytes: PNG }), 'SARVAM_INVALID_RESPONSE');
    assert.equal(f.count('status'), 0, `no status call for id ${JSON.stringify(bad)}`);
  }
});

test('failed and rejected jobs are errors, never results', async () => {
  for (const s of ['failed', 'rejected']) {
    const { f, p } = mk({ create: [created()], status: [status(s)] });
    await rejectsWith(p.digitise({ name: 'a.png', bytes: PNG }), 'SARVAM_JOB_FAILED');
    assert.equal(f.count('results'), 0);
  }
});

test('create already returns a terminal failure state: no polling, no results fetch', async () => {
  const { f, p } = mk({ create: [created('rejected')] });
  await rejectsWith(p.digitise({ name: 'a.png', bytes: PNG }), 'SARVAM_JOB_FAILED');
  assert.equal(f.count('status') + f.count('results'), 0);
});

test('partially_completed: returned pages kept, missing pages appear as EMPTY unreadable pages (never invented)', async () => {
  const { p } = mk({
    create: [created()],
    status: [status('partially_completed', { pages_total: 3, pages_processed: 3, pages_succeeded: 2, pages_failed: 1 })],
    results: [results([page(1, 'First page has plenty of text'), page(3, 'Third page has plenty of text')])],
  });
  const r = await p.digitise({ name: 'a.pdf', bytes: PDF });
  assert.equal(r.partial, true);
  assert.deepEqual(r.pages.map((x) => x.n), [1, 2, 3]);
  assert.equal(r.pages[1].text, '');
  assert.equal(r.usage.pages_failed, 1);
});

test('HTTP errors on create map to stable codes; vendor bodies and signed URLs are never copied into errors', async () => {
  const LEAK = 'VENDOR-SECRET-DETAIL https://storage.example.com/x?signature=abc123';
  const table = [[400, 'SARVAM_BAD_REQUEST', 422], [401, 'SARVAM_AUTH', 502], [402, 'SARVAM_BILLING', 502], [403, 'SARVAM_AUTH', 502], [404, 'SARVAM_NOT_FOUND', 502], [409, 'SARVAM_CONFLICT', 502],
    [413, 'SARVAM_TOO_LARGE', 413], [422, 'SARVAM_UNPROCESSABLE', 422], [429, 'SARVAM_RATE_LIMITED', 429], [500, 'SARVAM_UNAVAILABLE', 503], [503, 'SARVAM_UNAVAILABLE', 503], [418, 'SARVAM_INVALID_RESPONSE', 502]];
  for (const [http, code, mapped] of table) {
    const { f, p } = mk({ create: [json(http, { detail: LEAK, title: LEAK, errors: [{ message: LEAK }] })] });
    const e = await rejectsWith(p.digitise({ name: 'a.png', bytes: PNG }), code);
    assert.equal(e.status, mapped);
    for (const s of [e.message, JSON.stringify(e), String(e.stack).split('\n')[0]]) {
      assert.ok(!s.includes('VENDOR-SECRET'), 'no vendor text'); assert.ok(!s.includes('signature=abc'), 'no signed url'); assert.ok(!s.includes(KEY), 'no key');
    }
    assert.equal(f.count('create'), 1, 'the paid create call is never retried');
  }
});

test('transient poll errors (429/5xx/timeouts) are tolerated a bounded number of times, then surface', async () => {
  const flaky = mk({ create: [created()], status: [json(429, {}), json(503, {}), status('completed')], results: [results([page(1, 'ok page text')])] });
  assert.equal((await flaky.p.digitise({ name: 'a.png', bytes: PNG })).pages.length, 1);
  const dead = mk({ create: [created()], status: [json(503, {})] }, { maxTransientPollErrors: 3, maxPolls: 50 });
  await rejectsWith(dead.p.digitise({ name: 'a.png', bytes: PNG }), 'SARVAM_UNAVAILABLE');
  assert.equal(dead.f.count('status'), 4);
  const rl = mk({ create: [created()], status: [json(429, {})] }, { maxTransientPollErrors: 1, maxPolls: 50 });
  await rejectsWith(rl.p.digitise({ name: 'a.png', bytes: PNG }), 'SARVAM_RATE_LIMITED');
});

test('non-transient poll errors stop immediately (auth, not found, bad request)', async () => {
  for (const [http, code] of [[403, 'SARVAM_AUTH'], [404, 'SARVAM_NOT_FOUND'], [400, 'SARVAM_BAD_REQUEST']]) {
    const { f, p } = mk({ create: [created()], status: [json(http, {})] });
    await rejectsWith(p.digitise({ name: 'a.png', bytes: PNG }), code);
    assert.equal(f.count('status'), 1);
  }
});

test('poll limit: a job that never finishes is abandoned after maxPolls, with a bounded number of requests', async () => {
  const { f, p } = mk({ create: [created()], status: [status('running')] }, { maxPolls: 5 });
  await rejectsWith(p.digitise({ name: 'a.png', bytes: PNG }), 'SARVAM_POLL_LIMIT');
  assert.equal(f.count('status'), 5);
  assert.equal(f.count('results'), 0);
});

test('wall-clock deadline also ends polling', async () => {
  let t = 0;
  const { p } = mk({ create: [created()], status: [status('running')] }, { maxPolls: 1000, totalDeadlineMs: 1000 }, { now: () => (t += 400) });
  await rejectsWith(p.digitise({ name: 'a.png', bytes: PNG }), 'SARVAM_POLL_LIMIT');
});

test('request timeout: a hung connection is aborted and reported, not left hanging', async () => {
  const hang = (url, opts) => new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  const { p } = mk({ create: [hang] }, { requestTimeoutMs: 40 });
  const t0 = Date.now();
  await rejectsWith(p.digitise({ name: 'a.png', bytes: PNG }), 'SARVAM_TIMEOUT');
  assert.ok(Date.now() - t0 < 2000);
});

test('network failure maps to unavailable (no raw error text)', async () => {
  const boom = () => { throw new Error('getaddrinfo ENOTFOUND api.sarvam.ai SECRET'); };
  const { p } = mk({ create: [boom] });
  const e = await rejectsWith(p.digitise({ name: 'a.png', bytes: PNG }), 'SARVAM_UNAVAILABLE');
  assert.ok(!e.message.includes('ENOTFOUND'));
});

test('cancellation: aborting while waiting stops polling and reports cancelled', async () => {
  const ac = new AbortController();
  const f = mockFetch({ create: [created()], status: [status('running')] });
  const p = createSarvamProvider({ apiKey: KEY, fetchImpl: f, sleep: async () => { ac.abort(); }, limits: { pollIntervalMs: 0 } });
  await rejectsWith(p.digitise({ name: 'a.png', bytes: PNG, signal: ac.signal }), 'SARVAM_CANCELLED');
  assert.equal(f.count('results'), 0);
  const pre = new AbortController(); pre.abort();
  const f2 = mockFetch(ok());
  await rejectsWith(createSarvamProvider({ apiKey: KEY, fetchImpl: f2, sleep: noSleep }).digitise({ name: 'a.png', bytes: PNG, signal: pre.signal }), 'SARVAM_CANCELLED');
  assert.equal(f2.calls.length, 0);
});

test('malformed provider output is rejected, never coerced into success', async () => {
  const cases = {
    'create is not JSON': { create: [json(201, 'not json')] },
    'create JSON is an array': { create: [json(201, '[1,2]')] },
    'status is not JSON': { create: [created()], status: [json(200, '<html>')] },
    'status has no state': { create: [created()], status: [json(200, { job_id: JOB })] },
    'unknown job state': { create: [created()], status: [status('exploded')] },
    'results not JSON': { create: [created()], status: [status('completed')], results: [json(200, 'nope')] },
    'results has no documents': { create: [created()], status: [status('completed')], results: [json(200, { job_id: JOB, status: 'completed' })] },
    'documents empty': { create: [created()], status: [status('completed')], results: [json(200, { documents: [] })] },
    'pages not an array': { create: [created()], status: [status('completed')], results: [json(200, { documents: [{ pages: 'x' }] })] },
    'page number is a string': { create: [created()], status: [status('completed')], results: [results([page('1', 'abc')], {})].map((r) => r) },
    'page number zero': { create: [created()], status: [status('completed')], results: [results([page(0, 'abc')])] },
    'page number negative': { create: [created()], status: [status('completed')], results: [results([page(-2, 'abc')])] },
    'page number float': { create: [created()], status: [status('completed')], results: [results([page(1.5, 'abc')])] },
    'duplicate page numbers': { create: [created()], status: [status('completed')], results: [results([page(1, 'a'), page(1, 'b')])] },
    'gap in page numbers': { create: [created()], status: [status('completed')], results: [results([page(1, 'a'), page(3, 'b')])] },
    'content not a string': { create: [created()], status: [status('completed')], results: [results([{ page_number: 1, content: { html: 1 } }])] },
    'page is null': { create: [created()], status: [status('completed')], results: [results([null])] },
    'job id mismatch': { create: [created()], status: [status('completed')], results: [json(200, { job_id: 'someone_else', documents: [{ pages: [page(1, 'x')] }] })] },
    'results is a 500': { create: [created()], status: [status('completed')], results: [json(500, {})] },
    'results is a 409': { create: [created()], status: [status('completed')], results: [json(409, {})] },
  };
  for (const [name, script] of Object.entries(cases)) {
    const { p } = mk(script);
    try { await p.digitise({ name: 'a.png', bytes: PNG }); assert.fail(`${name}: should have been rejected`); } catch (e) {
      assert.ok(e instanceof SarvamError, `${name}: ${e.message}`);
      assert.ok(/^SARVAM_/.test(e.code), `${name}: code ${e.code}`);
    }
  }
});

test('a PDF result without page numbers is rejected; a single image result may default to page 1 only', async () => {
  const noNum = results([{ content: 'text without a page number' }]);
  await rejectsWith(mk({ create: [created()], status: [status('completed')], results: [noNum] }).p.digitise({ name: 'a.pdf', bytes: PDF }), 'SARVAM_INVALID_RESPONSE');
  const img = await mk({ create: [created()], status: [status('completed')], results: [noNum] }).p.digitise({ name: 'a.png', bytes: PNG });
  assert.deepEqual(img.pages.map((x) => x.n), [1]);
  const two = results([{ content: 'a' }, { content: 'b' }]);
  await rejectsWith(mk({ create: [created()], status: [status('completed')], results: [two] }).p.digitise({ name: 'a.png', bytes: PNG }), 'SARVAM_INVALID_RESPONSE');
});

test('page limit: more than 10 returned pages is rejected', async () => {
  const { p } = mk(ok(11));
  await rejectsWith(p.digitise({ name: 'a.pdf', bytes: PDF }), 'SARVAM_INVALID_RESPONSE');
  assert.equal((await mk(ok(10)).p.digitise({ name: 'a.pdf', bytes: PDF })).pages.length, 10);
});

test('oversized responses are refused (content-length and body)', async () => {
  const big = new Response('{"x":"' + 'a'.repeat(600) + '"}', { status: 201, headers: { 'content-length': '999999999' } });
  await rejectsWith(mk({ create: [big] }, { maxResponseBytes: 500 }).p.digitise({ name: 'a.png', bytes: PNG }), 'SARVAM_INVALID_RESPONSE');
  await rejectsWith(mk({ create: [json(201, { job_id: JOB, pad: 'a'.repeat(600) })] }, { maxResponseBytes: 500 }).p.digitise({ name: 'a.png', bytes: PNG }), 'SARVAM_INVALID_RESPONSE');
});

test('plainText: markdown/HTML to inert text; URLs, tags and control characters removed; length capped', () => {
  assert.equal(plainText('## Title\n> quote\n**bold** and `code`'), 'Title\nquote\nbold and code');
  assert.equal(plainText('| A | B |\n|:--|--:|\n| 1 | 2 |'), 'A  B\n1  2');
  assert.equal(plainText('<table><tr><td>Total</td><td>₹ 1,000</td></tr></table>').replace(/\s+/g, ' ').trim(), 'Total ₹ 1,000');
  assert.equal(plainText('see ![scan](https://signed.example.com/a?sig=1) and [link](https://x.example.com/?t=2)'), 'see scan and link');
  assert.equal(plainText('a\u0000b\u0007c'), 'abc');
  const inj = plainText('<script>alert(1)</script><img src=x onerror=alert(2)> Hello &lt;b&gt;');
  assert.ok(!/<script|<img/.test(inj));
  assert.match(inj, /Hello <b>/); // entity text stays inert text; the UI renders with textContent only
  assert.equal(plainText('x'.repeat(50000), 100).length, 100);
  assert.equal(plainText(null), '');
});

test('translate: exact request schema and a validated response', async () => {
  const f = mockFetch({ translate: [json(200, { request_id: 'r1', translated_text: 'नमस्ते CLM-DEMO-0001', source_language_code: 'en-IN' })] });
  const p = createSarvamProvider({ apiKey: KEY, fetchImpl: f });
  const out = await p.translate({ text: 'Hello CLM-DEMO-0001', source: 'en-IN', target: 'hi-IN' });
  assert.equal(out.translatedText, 'नमस्ते CLM-DEMO-0001');
  const c = f.calls[0];
  assert.equal(c.url, 'https://api.sarvam.ai/translate');
  assert.equal(c.opts.headers['api-subscription-key'], KEY);
  assert.equal(c.opts.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(c.opts.body), { input: 'Hello CLM-DEMO-0001', source_language_code: 'en-IN', target_language_code: 'hi-IN', model: 'sarvam-translate:v1', mode: 'formal', numerals_format: 'international' });
});

test('translate: input limits, language checks and error mapping', async () => {
  const f = mockFetch({ translate: [json(429, { error: { message: 'VENDOR-SECRET' } })] });
  const p = createSarvamProvider({ apiKey: KEY, fetchImpl: f });
  await rejectsWith(p.translate({ text: '' }), 'INPUT_INVALID');
  await rejectsWith(p.translate({ text: 'x'.repeat(2001) }), 'INPUT_INVALID');
  await rejectsWith(p.translate({ text: 'hi', source: 'en-IN', target: 'en-IN' }), 'INPUT_INVALID');
  await rejectsWith(p.translate({ text: 'hi', target: 'zz-ZZ' }), 'INPUT_INVALID');
  assert.equal(f.calls.length, 0);
  const e = await rejectsWith(p.translate({ text: 'hi' }), 'SARVAM_RATE_LIMITED');
  assert.ok(!e.message.includes('VENDOR-SECRET'));
  for (const bad of [json(200, { translated_text: 5 }), json(200, { translated_text: '   ' }), json(200, 'x'), json(200, {})]) {
    await rejectsWith(createSarvamProvider({ apiKey: KEY, fetchImpl: mockFetch({ translate: [bad] }) }).translate({ text: 'hi' }), 'SARVAM_INVALID_RESPONSE');
  }
});

test('only the official Sarvam host over https is ever contacted (checked across every test in this file)', () => {
  assert.ok(H.seenUrls.length > 20);
  for (const u of H.seenUrls) { const x = new URL(u); assert.equal(x.protocol, 'https:'); assert.equal(x.hostname, OFFICIAL_HOST); assert.equal(x.port, ''); }
});

test('result page shape: only the explicitly listed field names are understood; anything else is rejected, never guessed', async () => {
  const run = async (pages) => {
    const fetchImpl = mockFetch({ create: [created('completed')], results: [results(pages)] });
    const p = createSarvamProvider({ apiKey: KEY, fetchImpl, sleep: noSleep });
    return p.digitise({ name: 'a.pdf', bytes: PDF, language: 'en-IN' });
  };
  const ok = await run([{ page_num: 1, markdown: '# Bill\nTotal 1,000' }, { page_number: 2, text: 'second page' }]);
  assert.deepEqual(ok.pages.map((p) => p.n), [1, 2]);
  assert.match(ok.pages[0].text, /Bill/);
  assert.equal(ok.pages[1].text, 'second page');
  for (const bad of [[{ pageNumber: 1, content: 'x' }], [{ page: 1, content: 'x' }], [{ page_num: '1', content: 'x' }], [{ page_num: 1, markdown: { html: '<b>x</b>' } }], [{ page_num: 1, content: 'a' }, { page_num: 1, content: 'b' }]]) {
    await assert.rejects(() => run(bad), (e) => e.code === 'SARVAM_INVALID_RESPONSE');
  }
});
