'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mkStore, b64, codes, reqStatus } = require('./helpers');
const { loadConfig } = require('../src/config');
const { AnalysisManager } = require('../src/analysis');
const { SarvamError } = require('../src/providers/sarvam');
const fixtures = require('../src/fixtures');
const i18n = require('../src/i18n');
const { KEY, PNG, PDF } = require('./helpers-sarvam');

const on = () => loadConfig({ AI_PROVIDER: 'sarvam', SARVAM_API_KEY: KEY });
const LAB = fixtures.SAMPLES.find((s) => s.id === 'S-LAB').pages[0];
const cloudPages = (...texts) => texts.map((text, i) => ({ n: i + 1, text, ocr: { method: 'sarvam-document-ai', engine: 'Sarvam Document AI', confidence: null, status: 'verify', jobId: 'job_1', rawChars: text.length } }));
const result = (pages = cloudPages(LAB), extra = {}) => ({ jobId: 'job_1', partial: false, usage: { pages_total: pages.length }, language: 'en-IN', pages, ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
/** A provider whose digitise() is controlled by the test. */
function fakeProvider(impl) {
  const p = { configured: true, calls: [], digitise: (args) => { p.calls.push(args); return impl(args); }, translate: async () => { throw new Error('translate not configured'); } };
  return p;
}
const setup = (impl, opts = {}) => {
  const store = mkStore();
  const provider = opts.provider || fakeProvider(impl || (async () => result()));
  const mgr = new AnalysisManager({ store, config: opts.config || on(), provider, ...opts.mgr });
  return { store, mgr, provider };
};
const upload = (name = 'lab.png', buf = PNG) => ({ name, dataBase64: buf.toString('base64'), externalProcessingConsent: true });
const settle = async (mgr, role, id) => { for (let i = 0; i < 50; i++) { const v = mgr.get(role, id); if (v.status !== 'running') return v; await new Promise((r) => setTimeout(r, 5)); } throw new Error('still running'); };
const rejects = async (fn, code, status) => { try { await fn(); } catch (e) { assert.equal(e.code, code, e.message); if (status) assert.equal(e.status, status); return e; } assert.fail('expected ' + code); };
const frozenState = (store) => { const s = JSON.parse(JSON.stringify(store.state)); delete s.events; return JSON.stringify(s); };

test('rules mode (default): analysis is refused, the provider is never called, the normal upload still works', async () => {
  const provider = fakeProvider(async () => result());
  const store = mkStore();
  const mgr = new AnalysisManager({ store, config: loadConfig({}), provider });
  assert.equal(mgr.enabled(), false);
  await rejects(() => mgr.start('claimant', upload()), 'AI_PROVIDER_DISABLED', 503);
  await rejects(() => mgr.translate('claimant', { externalProcessingConsent: true }), 'AI_PROVIDER_DISABLED', 503);
  assert.equal(provider.calls.length, 0);
  store.uploadDocument('claimant', { name: 'ok.txt', dataBase64: b64('A plain local text file for the packet.') });
  assert.equal(mgr.status().badge, 'rules_only');
  assert.deepEqual(mgr.status().sampleScans, []);
});

test('invalid or keyless configuration also keeps cloud analysis off', async () => {
  for (const env of [{ AI_PROVIDER: 'bogus', SARVAM_API_KEY: KEY }, { AI_PROVIDER: 'sarvam' }]) {
    const { mgr, provider } = setup(null, { config: loadConfig(env) });
    await rejects(() => mgr.start('claimant', upload()), 'AI_PROVIDER_DISABLED', 503);
    assert.equal(provider.calls.length, 0);
    assert.notEqual(mgr.status().badge, 'sarvam_available');
  }
});

test('consent must be exactly boolean true on every call; anything else is refused before the provider is touched', async () => {
  const { mgr, provider, store } = setup();
  for (const c of [undefined, false, 'true', 1, 'yes', null, {}, [true]]) {
    await rejects(() => mgr.start('claimant', { ...upload(), externalProcessingConsent: c }), 'CONSENT_REQUIRED', 422);
    await rejects(() => mgr.translate('claimant', { externalProcessingConsent: c }), 'CONSENT_REQUIRED', 422);
  }
  const { externalProcessingConsent, ...noConsent } = upload();
  await rejects(() => mgr.start('claimant', noConsent), 'CONSENT_REQUIRED', 422);
  assert.equal(provider.calls.length, 0);
  assert.equal(store.events().filter((e) => e.type.startsWith('cloud_')).length, 0);
});

test('bytes and metadata are validated like any upload: type, size, magic, empty, language, unknown sample', async () => {
  const { mgr, provider } = setup();
  await rejects(() => mgr.start('claimant', upload('note.txt', Buffer.from('plain text'))), 'CLOUD_TYPE_UNSUPPORTED', 415);
  await rejects(() => mgr.start('claimant', upload('x.exe', Buffer.from('MZ'))), 'UNSUPPORTED_FILE_TYPE', 415);
  await rejects(() => mgr.start('claimant', upload('fake.png', Buffer.from('definitely not a png'))), 'FILE_CONTENT_MISMATCH', 415);
  await rejects(() => mgr.start('claimant', { ...upload(), dataBase64: '' }), 'FILE_EMPTY');
  await rejects(() => mgr.start('claimant', { ...upload(), dataBase64: '***not-base64***' }), 'FILE_ENCODING_INVALID', 422);
  await rejects(() => mgr.start('claimant', upload('big.png', Buffer.concat([PNG, Buffer.alloc(1_100_000)]))), 'FILE_TOO_LARGE', 413);
  await rejects(() => mgr.start('claimant', { ...upload(), language: 'klingon' }), 'LANGUAGE_UNSUPPORTED', 422);
  await rejects(() => mgr.start('claimant', { ...upload(), language: { x: 1 } }), 'LANGUAGE_UNSUPPORTED', 422);
  await rejects(() => mgr.start('claimant', { externalProcessingConsent: true, sampleScanId: '../../etc/passwd' }), 'SAMPLE_NOT_FOUND', 404);
  await rejects(() => mgr.start('claimant', { externalProcessingConsent: true, sampleScanId: '__proto__' }), 'SAMPLE_NOT_FOUND', 404);
  assert.equal(provider.calls.length, 0);
});

test('roles and lifecycle: unknown roles are refused; the claimant packet is frozen after submission', async () => {
  const { mgr, store } = setup();
  await rejects(() => mgr.start('hacker', upload()), 'FORBIDDEN_ROLE', 403);
  const ok = mgr.start('claimant', upload());
  await settle(mgr, 'claimant', ok.id);
  await rejects(() => mgr.get('reviewer', ok.id), 'ANALYSIS_NOT_FOUND', 404);
  await rejects(() => mgr.confirm('reviewer', ok.id), 'ANALYSIS_NOT_FOUND', 404);
  await rejects(() => mgr.cancel('reviewer', ok.id), 'ANALYSIS_NOT_FOUND', 404);
  assert.equal(store.status, 'preparing');
});

test('full flow: consent -> running -> ready (inspect) -> confirm adds a document marked machine-read; nothing is auto-accepted', async () => {
  const { mgr, store, provider } = setup();
  const before = store.view();
  assert.equal(reqStatus(store, 'lab').status, 'missing');
  const s = mgr.start('claimant', upload('lab_scan.png'));
  assert.equal(s.status, 'running');
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].language, 'en-IN');
  const ready = await settle(mgr, 'claimant', s.id);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.result.confidence, 'not supplied');
  assert.match(ready.result.notice, /verify amounts and IDs against the original/i);
  assert.equal(ready.result.pages[0].n, 1);
  assert.ok(ready.result.fields.length >= 1);
  for (const f of ready.result.fields) { assert.ok(f.page >= 1 && f.excerpt, 'each previewed field cites page + excerpt'); }
  // inspection alone changes nothing in the case
  assert.deepEqual(store.view().documents.map((d) => d.id), before.documents.map((d) => d.id));
  assert.equal(reqStatus(store, 'lab').status, 'missing');
  assert.equal(mgr.status().badge, 'sarvam_available', 'not "used" until a result is actually consumed');

  const done = mgr.confirm('claimant', s.id);
  assert.equal(done.analysis.status, 'confirmed');
  const doc = store.view().documents.find((d) => d.id === done.document.id);
  assert.equal(doc.extraction.kind, 'cloud');
  assert.equal(doc.extraction.provider, 'sarvam-document-ai');
  assert.equal(doc.pages[0].ocr.status, 'verify');
  assert.equal(doc.pages[0].ocr.confidence, null);
  assert.equal(mgr.status().badge, 'sarvam_used');
  assert.equal(store.snapshot('claimant').meta.ai.live, true);
  // the matching requirement is no longer "missing" but is NOT "matched": a person must check the original
  const st = reqStatus(store, 'lab');
  assert.equal(st.status, 'needs_review');
  assert.match(st.explanation, /machine-read/);
  const link = store.state.links.find((l) => l.docId === doc.id);
  assert.notEqual(link.decision, 'accepted');
  // bulk "accept clean matches" cannot sweep it up
  try { store.acceptSuggested('claimant'); } catch { /* may be refused for other reasons */ }
  assert.notEqual(store.state.links.find((l) => l.docId === doc.id).decision, 'accepted');
  // and it cannot be confirmed twice
  await rejects(() => mgr.confirm('claimant', s.id), 'ANALYSIS_NOT_READY', 409);
});

test('cloud output cannot clear an existing blocker or mark the packet ready', async () => {
  const { mgr, store } = setup(async () => result(cloudPages('Total: 1,000\nPharmacy memo')));
  const blockersBefore = store.analysis().readiness.blockers.length;
  assert.ok(blockersBefore > 0);
  const s = mgr.start('claimant', upload('extra.png'));
  await settle(mgr, 'claimant', s.id);
  mgr.confirm('claimant', s.id);
  assert.ok(store.analysis().readiness.blockers.some((b) => /pharmacy|unreadable/i.test(JSON.stringify(b))) || store.analysis().readiness.blockers.length >= 1);
  assert.throws(() => store.transition('claimant', 'ready_for_review'), (e) => e.status === 409 || e.status === 422);
  assert.equal(store.status, 'preparing');
});

test('provider failure: job fails with a SAFE message and the case is byte-for-byte unchanged (events aside)', async () => {
  const LEAK = 'VENDOR-LEAK https://signed.example.com/?sig=1';
  for (const err of [new SarvamError('SARVAM_RATE_LIMITED', 'Sarvam is rate-limiting requests. Try again later.', 429), new Error(LEAK), new SarvamError('SARVAM_TIMEOUT', 'Sarvam did not answer in time.', 504)]) {
    const { mgr, store } = setup(async () => { throw err; });
    const before = frozenState(store);
    const s = mgr.start('claimant', upload());
    const v = await settle(mgr, 'claimant', s.id);
    assert.equal(v.status, 'failed');
    assert.ok(v.error.code && v.error.message);
    assert.ok(!JSON.stringify(v).includes('VENDOR-LEAK'), 'unexpected errors never echo their text');
    assert.ok(!JSON.stringify(v).includes('signed.example.com'));
    assert.equal(frozenState(store), before);
    await rejects(() => mgr.confirm('claimant', s.id), 'ANALYSIS_NOT_READY', 409);
    assert.equal(mgr.status().badge, 'sarvam_available');
    assert.equal(store.events().some((e) => e.type === 'cloud_analysis_failed'), true);
  }
});

test('a malformed result can never be added (store re-validates pages, method and verify status)', () => {
  const store = mkStore();
  const base = { name: 'x.png', mime: 'image/png', size: 10, sha256: 'a'.repeat(64), jobId: 'j1', language: 'en-IN' };
  const good = cloudPages('Some readable text on the page');
  const bad = [
    [], null, 'x', [{ n: 2, text: 'skips page one', ocr: good[0].ocr }],
    [{ n: 1, text: 5, ocr: good[0].ocr }], [{ n: 1, text: 'no ocr meta' }],
    [{ n: 1, text: 'claims a confidence', ocr: { ...good[0].ocr, status: 'ok' } }],
    [{ n: 1, text: 'wrong method', ocr: { ...good[0].ocr, method: 'ocr' } }],
  ];
  for (const pages of bad) assert.throws(() => store.addCloudDocument('claimant', { ...base, pages }), (e) => e.code === 'CLOUD_RESULT_INVALID', JSON.stringify(pages).slice(0, 60));
  assert.equal(store.view().documents.length, 7);
  assert.throws(() => store.addCloudDocument('hacker', { ...base, pages: good }), (e) => e.status === 403);
});

test('unknown or missing source references never become accepted links; unreadable cloud pages stay blockers', async () => {
  const { mgr, store } = setup(async () => result(cloudPages('too short')));
  const s = mgr.start('claimant', upload('blank.png'));
  const v = await settle(mgr, 'claimant', s.id);
  assert.equal(v.result.pages[0].readable, false);
  mgr.confirm('claimant', s.id);
  const d = store.view().documents.find((x) => x.name === 'blank.png');
  assert.equal(d.pages[0].readable, false);
  assert.ok(store.state.links.filter((l) => l.docId === d.id).every((l) => l.decision !== 'accepted'));
  assert.throws(() => store.manualLink('claimant', { reqId: store.state.requirements[0].id, docId: d.id, page: 7 }), (e) => e.status >= 400);
});

test('machine-read values: a difference is "needs review", never a hard mismatch, and is never called fraud', async () => {
  const claimFormText = 'Patient Name: Aarav Mehta\nAmount Claimed: ₹ 9,99,999\nPolicy No: POL-DEMO-48213\nClaim reference: CLM-DEMO-0001';
  const { mgr, store } = setup(async () => result(cloudPages(claimFormText)));
  const orig = store.view().documents.find((d) => d.name === 'claim_form.txt');
  const s = mgr.start('claimant', upload('claim_form.png'));
  await settle(mgr, 'claimant', s.id);
  mgr.confirm('claimant', { id: s.id }.id);
  const open = store.findingsList().filter((f) => f.status === 'open');
  assert.ok(!open.some((f) => f.code === 'FIELD_MISMATCH' && /claim_form\.png/.test(f.title)), 'no hard mismatch from machine-read text');
  for (const f of open) assert.ok(!/fraud/i.test(f.title + f.explanation) || /not a determination of fraud/i.test(f.explanation));
  assert.ok(orig);
});

test('cancel: a running job is abandoned, a late result is ignored, and nothing is added', async () => {
  const d = deferred();
  let aborted = false;
  const { mgr, store, provider } = setup(({ signal }) => { signal.addEventListener('abort', () => { aborted = true; }); return d.promise; });
  const before = frozenState(store);
  const s = mgr.start('claimant', upload());
  assert.equal(mgr.cancel('claimant', s.id).status, 'cancelled');
  assert.equal(aborted, true);
  d.resolve(result());
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(mgr.get('claimant', s.id).status, 'cancelled');
  assert.equal(mgr.get('claimant', s.id).result, undefined);
  await rejects(() => mgr.confirm('claimant', s.id), 'ANALYSIS_NOT_READY', 409);
  assert.equal(frozenState(store), before);
  assert.equal(provider.calls.length, 1);
  await rejects(() => mgr.cancel('claimant', s.id), 'ANALYSIS_NOT_CANCELLABLE', 409);
  assert.ok(store.events().some((e) => e.type === 'cloud_analysis_cancelled'));
});

test('a finished analysis can be discarded without adding anything', async () => {
  const { mgr, store } = setup();
  const before = frozenState(store);
  const s = mgr.start('claimant', upload());
  await settle(mgr, 'claimant', s.id);
  assert.equal(mgr.cancel('claimant', s.id).status, 'discarded');
  await rejects(() => mgr.confirm('claimant', s.id), 'ANALYSIS_NOT_READY', 409);
  assert.equal(frozenState(store), before);
});

test('concurrency cap and hourly budget protect the paid key', async () => {
  const d = deferred();
  const { mgr } = setup(() => d.promise, { mgr: { maxConcurrent: 2, budgetPerHour: 3 } });
  const a = mgr.start('claimant', upload('a.png')); mgr.start('claimant', upload('b.png'));
  await rejects(() => mgr.start('claimant', upload('c.png')), 'ANALYSIS_BUSY', 429);
  d.resolve(result());
  await settle(mgr, 'claimant', a.id);
  mgr.start('claimant', upload('d.png'));
  await rejects(() => mgr.start('claimant', upload('e.png')), 'CLOUD_BUDGET_EXCEEDED', 429);
});

test('hourly budget slides: old calls expire', async () => {
  let t = 1_000_000;
  const { mgr } = setup(null, { mgr: { budgetPerHour: 1, now: () => t } });
  const a = mgr.start('claimant', upload('a.png'));
  await settle(mgr, 'claimant', a.id);
  await rejects(() => mgr.start('claimant', upload('b.png')), 'CLOUD_BUDGET_EXCEEDED', 429);
  t += 3_700_000;
  mgr.start('claimant', upload('c.png'));
});

test('jobs expire, and unknown ids are 404 (no id guessing information)', async () => {
  let t = 5_000;
  const { mgr } = setup(null, { mgr: { ttlMs: 1000, now: () => t } });
  const s = mgr.start('claimant', upload());
  await settle(mgr, 'claimant', s.id);
  t += 2_000;
  await rejects(() => mgr.get('claimant', s.id), 'ANALYSIS_NOT_FOUND', 404);
  await rejects(() => mgr.get('claimant', 'nope'), 'ANALYSIS_NOT_FOUND', 404);
  await rejects(() => mgr.get('claimant', '__proto__'), 'ANALYSIS_NOT_FOUND', 404);
});

test('sample scans come from a fixed allow-list and are read server-side', async () => {
  const { mgr, provider } = setup();
  assert.deepEqual(mgr.status().sampleScans.map((s) => s.id).sort(), ['lab_report_scan', 'pharmacy_bill_scan_corrected']);
  const s = mgr.start('claimant', { externalProcessingConsent: true, sampleScanId: 'lab_report_scan' });
  assert.equal(provider.calls[0].name, 'lab_report_scan.pdf');
  assert.equal(Buffer.from(provider.calls[0].bytes).slice(0, 5).toString(), '%PDF-');
  const v = await settle(mgr, 'claimant', s.id);
  assert.equal(v.name, 'lab_report_scan.pdf');
});

test('audit trail: ids, hashes and codes only, never document text, the key, or raw payloads; bytes are dropped after the call', async () => {
  const SECRET = 'TOP-SECRET-PATIENT-TEXT-98765';
  const { mgr, store, provider } = setup(async () => result(cloudPages(`Patient Name: ${SECRET}\nTotal: 1,000`)));
  const s = mgr.start('claimant', upload('secret.png'));
  await settle(mgr, 'claimant', s.id);
  mgr.confirm('claimant', s.id);
  const log = JSON.stringify(store.events());
  assert.ok(!log.includes(SECRET), 'document text is not in the audit trail');
  assert.ok(!log.includes(KEY));
  assert.ok(!log.includes(PNG.toString('base64').slice(0, 40)));
  const types = store.events().map((e) => e.type);
  for (const t of ['cloud_analysis_started', 'cloud_analysis_ready', 'document_added']) assert.ok(types.includes(t), t);
  const started = store.events().find((e) => e.type === 'cloud_analysis_started');
  assert.equal(started.data.consent, true);
  assert.equal(started.data.provider, 'sarvam-document-ai');
  assert.equal(started.data.sha256.length, 12);
  assert.equal(JSON.stringify(started).includes('dataBase64'), false);
  assert.equal(store.events().find((e) => e.type === 'document_added' && e.data.cloud).data.cloud, true);
  // persisted state never holds raw bytes either
  assert.ok(!JSON.stringify(store.state).includes(PNG.toString('base64').slice(0, 40)));
  assert.ok(provider.calls.length === 1);
});

test('output injection strings are plain text in the API (the UI renders with textContent only)', async () => {
  const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>\u0000 Total: 1,000';
  const { mgr, store } = setup(async () => result(cloudPages('<script>alert(2)</script> Total amount: 1,000')));
  const s = mgr.start('claimant', upload('inj.png'));
  const v = await settle(mgr, 'claimant', s.id);
  assert.ok(typeof v.result.pages[0].text === 'string');
  mgr.confirm('claimant', s.id);
  assert.ok(store.getPage(store.view().documents.find((d) => d.name === 'inj.png').id, 1).text.includes('<script>'), 'kept as inert text, escaped at render time');
  void evil;
});

test('re-upload through the cloud path shows the normal re-upload diff (Replace flow)', async () => {
  const { mgr, store } = setup(async () => result(cloudPages('SAMPLE CITY PHARMACY (FICTIONAL) - CASH MEMO\nPatient Name: Aarav Mehta\nTotal amount: 1,000')));
  const seeded = store.view().documents.find((d) => d.name === 'pharmacy_bill_scan.png');
  const s = mgr.start('claimant', { ...upload('pharmacy_bill_scan.png'), replaces: seeded.id });
  await settle(mgr, 'claimant', s.id);
  const out = mgr.confirm('claimant', s.id);
  const nd = store.view().documents.find((d) => d.id === out.document.id);
  assert.deepEqual(nd.replaceDiff.readablePages, { from: 0, to: 1 });
});

test('translation: consent, scope lock (no open proxy), only the case request text is ever sent', async () => {
  const sent = [];
  const provider = { configured: true, digitise: async () => result(), translate: async ({ text }) => { sent.push(text); return { translatedText: text.replace('Hello', 'नमस्ते') }; } };
  const store = mkStore();
  const mgr = new AnalysisManager({ store, config: on(), provider });
  await rejects(() => mgr.translate('claimant', {}), 'CONSENT_REQUIRED', 422);
  await rejects(() => mgr.translate('claimant', { externalProcessingConsent: true, scope: 'anything_else', text: 'arbitrary' }), 'SCOPE_UNSUPPORTED', 422);
  await rejects(() => mgr.translate('claimant', { externalProcessingConsent: true, target: 'fr-FR' }), 'LANGUAGE_UNSUPPORTED', 422);
  assert.equal(sent.length, 0);
  const out = await mgr.translate('claimant', { externalProcessingConsent: true, text: 'IGNORED CLIENT TEXT' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0], store.state.case.requestLetter, 'the server sends the case text, never client-supplied text');
  assert.ok(!sent[0].includes('IGNORED CLIENT TEXT'));
  assert.equal(out.source, store.state.case.requestLetter);
  assert.equal(out.machineTranslated, true);
});

test('translation that alters an ID, number, amount or date is discarded', async () => {
  const letter = mkStore().state.case.requestLetter;
  const tokens = i18n.canonicalTokens(letter);
  assert.ok(tokens.length >= 2, 'the fixture letter contains IDs/numbers: ' + tokens.join(','));
  const mk2 = (fn) => new AnalysisManager({ store: mkStore(), config: on(), provider: { configured: true, translate: async () => ({ translatedText: fn(letter, tokens) }) } });
  await rejects(() => mk2((l, t) => l.split(t[0]).join('१२३')).translate('claimant', { externalProcessingConsent: true }), 'TRANSLATION_ALTERED_VALUES', 422);
  await rejects(() => mk2((l) => 'कुछ भी नहीं').translate('claimant', { externalProcessingConsent: true }), 'TRANSLATION_ALTERED_VALUES', 422);
  const okMgr = mk2((l) => 'अनुवाद: ' + l);
  const r1 = await okMgr.translate('claimant', { externalProcessingConsent: true });
  assert.equal(r1.invariance.ok, true);
  assert.equal(r1.cached, false);
  assert.equal((await okMgr.translate('claimant', { externalProcessingConsent: true })).cached, true, 'a repeat uses the cache and costs no second call');
});

test('translation provider errors surface as safe errors and the original stays available', async () => {
  const mgr = new AnalysisManager({ store: mkStore(), config: on(), provider: { configured: true, translate: async () => { throw new SarvamError('SARVAM_RATE_LIMITED', 'Sarvam is rate-limiting requests. Try again later.', 429); } } });
  await rejects(() => mgr.translate('claimant', { externalProcessingConsent: true }), 'SARVAM_RATE_LIMITED', 429);
  const boom = new AnalysisManager({ store: mkStore(), config: on(), provider: { configured: true, translate: async () => { throw new Error('VENDOR-LEAK'); } } });
  const e = await rejects(() => boom.translate('claimant', { externalProcessingConsent: true }), 'TRANSLATION_FAILED', 500);
  assert.ok(!e.message.includes('VENDOR-LEAK'));
});

/* ------------------------------ Hindi / English guidance ------------------------------ */

test('guidance: English and Hindi, original wording always present, same facts in both languages', () => {
  const store = mkStore();
  const en = store.guidance('claimant', 'en'), hi = store.guidance('claimant', 'hi');
  assert.equal(hi.lang, 'hi'); assert.equal(en.lang, 'en');
  assert.equal(hi.live, false); assert.equal(hi.mode, 'phrase-map');
  assert.equal(en.nextAction.text, store.nextAction(), 'English guidance equals the app\'s own next action text');
  assert.equal(hi.nextAction.original, store.nextAction(), 'the original English is kept beside the Hindi');
  assert.notEqual(hi.nextAction.text, hi.nextAction.original);
  assert.match(hi.nextAction.text, /[ऀ-ॿ]/);
  assert.match(hi.disclaimer, /कानूनी सलाह/);
  assert.match(hi.disclaimerEn, /not legal advice/i);
  assert.equal(hi.requirements.length, store.view().statuses.length);
  for (const [i, r] of hi.requirements.entries()) {
    assert.equal(r.original, store.view().statuses[i].label, 'requirement wording is preserved');
    assert.equal(r.status, en.requirements[i].status);
    assert.match(r.statusText, /[ऀ-ॿ]/);
    assert.match(r.statusOriginal, /^[A-Za-z ]+$/);
    assert.match(r.hint, /[ऀ-ॿ]/);
  }
  assert.equal(hi.findings.length, en.findings.length);
  for (const f of hi.findings) { assert.match(f.text, /[ऀ-ॿ]/, f.code); assert.ok(f.original && f.originalExplanation); }
});

test('guidance: IDs, amounts, dates, names and page numbers are copied verbatim, never translated or re-numbered', () => {
  const store = mkStore();
  const hi = store.guidance('reviewer', 'hi');
  const mismatch = hi.findings.find((f) => f.code === 'FIELD_MISMATCH');
  assert.ok(mismatch);
  const excerpts = mismatch.cites.map((c) => c.excerpt).join(' | ');
  assert.match(excerpts, /1,24,500/); assert.match(excerpts, /1,42,500/);
  assert.deepEqual(mismatch.cites.map((c) => [c.docName, c.page]), [['claim_form.txt', 1], ['hospital_final_bill.txt', 2]]);
  assert.match(mismatch.originalExplanation, /"1,24,500" vs "1,42,500"/);
  const allText = JSON.stringify(hi);
  assert.ok(!/[०-९]/.test(allText), 'no Devanagari numerals anywhere');
  assert.match(mismatch.text, /दस्तावेज़ी अंतर/);
  assert.match(mismatch.text, /दावेदार के बारे में कोई निष्कर्ष नहीं/);
  assert.ok(!/धोखा|फर्जी|जालसाज़ी/.test(allText), 'never uses fraud wording');
  assert.equal(hi.findings.every((f) => f.cites.every((c) => typeof c.page === 'number' && c.page >= 1)), true);
});

test('guidance: every reason code and status has both an English and a Hindi phrase', () => {
  const e = require('../src/engine');
  for (const code of Object.keys(e.CODES)) { assert.ok(i18n.FINDING[code], code); assert.ok(i18n.FINDING[code].en && /[ऀ-ॿ]/.test(i18n.FINDING[code].hi), code); }
  for (const st of ['matched', 'missing', 'unreadable', 'ambiguous', 'needs_review']) { const m = i18n.STATUS[st]; assert.ok(m.en && m.hintEn && /[ऀ-ॿ]/.test(m.hi) && /[ऀ-ॿ]/.test(m.hintHi), st); }
  for (const [k, v] of Object.entries(i18n.NEXT)) { assert.ok(v.en(2) && /[ऀ-ॿ]/.test(v.hi(2)), k); assert.match(v.hi(2), /2|(?:^[^0-9]*$)/); }
});

test('guidance: switching language does not change the case, and unsupported languages are refused', () => {
  const store = mkStore();
  const before = frozenState(store);
  store.guidance('claimant', 'hi'); store.guidance('claimant', 'en'); store.guidance('claimant', 'hi');
  assert.equal(frozenState(store), before);
  for (const bad of ['fr', 'xx', '', 'hi-IN', '__proto__', 'HI']) assert.throws(() => store.guidance('claimant', bad), (e) => e.code === 'LANG_UNSUPPORTED' && e.status === 422, bad);
  assert.throws(() => store.guidance('hacker', 'hi'), (e) => e.status === 403);
});

test('guidance follows the lifecycle: Hindi next-action text tracks the same state as the English one', () => {
  const store = mkStore();
  const seen = new Set();
  const snap = () => { const g = store.guidance('claimant', 'hi'); assert.equal(store.guidance('claimant', 'en').nextAction.text, store.nextAction()); seen.add(g.nextAction.text); };
  snap();
  store.addSample('claimant', { sampleId: 'S-LAB' }); store.addSample('claimant', { sampleId: 'S-PHARM' }); snap();
  store.transition('claimant', 'ready_for_review'); snap();
  assert.ok(seen.size >= 2);
});

test('canonical-token invariance check', () => {
  const src = 'Claim CLM-DEMO-0001 on 12/03/2026 for ₹1,24,500 (policy POL-DEMO-48213), 3 pages.';
  assert.deepEqual(i18n.canonicalTokens(src).sort(), ['12/03/2026', '1,24,500', '3', 'CLM-DEMO-0001', 'POL-DEMO-48213'].sort());
  assert.equal(i18n.checkInvariance(src, 'दावा CLM-DEMO-0001 दिनांक 12/03/2026 राशि ₹1,24,500 पॉलिसी POL-DEMO-48213, 3 पृष्ठ').ok, true);
  assert.equal(i18n.checkInvariance(src, 'दावा CLM-DEMO-0001 दिनांक 12/03/2026 राशि ₹1,42,500 पॉलिसी POL-DEMO-48213, 3 पृष्ठ').ok, false);
  assert.equal(i18n.checkInvariance(src, 'दावा CLM-DEMO-0001 12/03/2026 1,24,500 POL-DEMO-48213 ३').ok, false);
});
