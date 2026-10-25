'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ocr = require('../src/ocr');
const engine = require('../src/engine');
const { mkStore, codes, reqStatus } = require('./helpers');

const SAMPLES = path.join(__dirname, '..', 'samples');
const B64 = (f) => fs.readFileSync(path.join(SAMPLES, f)).toString('base64');
const HAVE = ocr.detect(true).available && ocr.detect().pdf;
const needOcr = { skip: HAVE ? false : 'local OCR tools (tesseract/poppler) not installed here' };
const tmpLeftovers = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('claimtrail-ocr-')).length;
const withOcrOff = (fn) => {
  const prev = process.env.CLAIMTRAIL_OCR; process.env.CLAIMTRAIL_OCR = 'off'; ocr.detect(true);
  try { return fn(); } finally { if (prev === undefined) delete process.env.CLAIMTRAIL_OCR; else process.env.CLAIMTRAIL_OCR = prev; ocr.detect(true); }
};
const pageOf = (store, name, n = 1) => { const d = store.view().documents.find((x) => x.name === name); return { d, p: d.pages[n - 1] }; };

test('confidence policy: low rejected, middle flagged to verify, high accepted (pure, no OCR tools needed)', () => {
  const raw = (confidence) => ({ text: 'Hospital bill total 1000', confidence });
  assert.equal(ocr.judge(1, raw(ocr.LOW_CONFIDENCE - 1), 'ocr', 'x').ocr.status, 'rejected_low_confidence');
  assert.equal(ocr.judge(1, raw(ocr.LOW_CONFIDENCE - 1), 'ocr', 'x').text, '');
  assert.equal(ocr.judge(1, raw(ocr.REVIEW_CONFIDENCE - 1), 'ocr', 'x').ocr.status, 'verify');
  assert.ok(ocr.judge(1, raw(ocr.REVIEW_CONFIDENCE - 1), 'ocr', 'x').text.length > 0);
  assert.equal(ocr.judge(1, raw(95), 'ocr', 'x').ocr.status, 'ok');
  assert.equal(ocr.judge(1, { text: '   ', confidence: 99 }, 'ocr', 'x').ocr.status, 'rejected_low_confidence');
});

test('status reports honestly that OCR is local software, not a model', () => {
  const s = ocr.status();
  assert.equal(s.isModel, false);
  assert.equal(typeof s.available, 'boolean');
  if (!s.available) assert.ok(s.reason);
});

test('OCR off or missing: images and PDFs degrade to unreadable with a reason; nothing throws', () => withOcrOff(() => {
  const store = mkStore();
  assert.equal(store.snapshot('claimant').ocr.available, false);
  const doc = store.uploadDocument('claimant', { name: 'scan_off.png', dataBase64: HAVE ? B64('pharmacy_bill_scan_corrected.png') : Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64') });
  const { d, p } = pageOf(store, doc.name);
  assert.equal(p.readable, false);
  assert.equal(p.ocr.status, 'unavailable');
  assert.equal(d.extraction.ocrAvailable, false);
}));

test('clean scanned image is read by OCR with provenance, classified, and field values extracted', needOcr, () => {
  const store = mkStore(); const before = tmpLeftovers();
  const doc = store.uploadDocument('claimant', { name: 'new_pharmacy_scan.png', dataBase64: B64('pharmacy_bill_scan_corrected.png') });
  const { d, p } = pageOf(store, doc.name);
  assert.equal(p.readable, true);
  assert.equal(p.ocr.method, 'ocr');
  assert.ok(p.ocr.confidence >= ocr.REVIEW_CONFIDENCE, `confidence ${p.ocr.confidence}`);
  assert.equal(p.ocr.status, 'ok');
  assert.notEqual(d.classification.type, 'unknown');
  assert.ok(Object.keys(d.fields).length >= 1, 'at least one field extracted');
  for (const f of Object.values(d.fields)) { assert.ok(f.page >= 1 && f.excerpt, 'every OCR field cites page + excerpt'); }
  const page = store.getPage(doc.id, 1);
  assert.match(page.text, /\S{3,}/);
  assert.equal(page.ocr.method, 'ocr');
  assert.equal(tmpLeftovers(), before, 'temp files are cleaned up');
});

test('degraded scan is rejected as unreadable: text discarded, reason kept, not silently trusted', needOcr, () => {
  const store = mkStore();
  const doc = store.uploadDocument('claimant', { name: 'poor_scan.png', dataBase64: B64('poor_scan_unreadable.png') });
  const { p } = pageOf(store, doc.name);
  assert.equal(p.readable, false);
  assert.equal(p.ocr.status, 'rejected_low_confidence');
  assert.ok(p.ocr.confidence < ocr.LOW_CONFIDENCE);
  assert.equal(store.getPage(doc.id, 1).text, '');
  assert.deepEqual(Object.keys(store.view().documents.find((x) => x.name === 'poor_scan.png').fields || {}), []);
});

test('image-only PDF is rasterised and OCR-read; it can satisfy the missing lab-report requirement', needOcr, () => {
  const store = mkStore();
  assert.equal(reqStatus(store, 'lab').status, 'missing');
  const doc = store.uploadDocument('claimant', { name: 'lab_report_scan.pdf', dataBase64: B64('lab_report_scan.pdf') });
  const { d, p } = pageOf(store, doc.name);
  assert.equal(p.ocr.method, 'ocr');
  assert.equal(p.readable, true);
  assert.notEqual(reqStatus(store, 'lab').status, 'missing');
  assert.ok(!codes(store).includes('REQ_MISSING') || !store.findingsList().some((f) => f.status === 'open' && f.code === 'REQ_MISSING' && /lab/i.test(f.title || '')));
  assert.equal(d.mime, 'application/pdf');
});

test('re-uploading the unreadable seeded scan with a real scan shows a re-upload diff (0 -> 1 readable pages)', needOcr, () => {
  const store = mkStore();
  const seeded = store.view().documents.find((d) => d.name === 'pharmacy_bill_scan.png');
  const doc = store.uploadDocument('claimant', { name: 'pharmacy_bill_scan.png', replaces: seeded.id, dataBase64: B64('pharmacy_bill_scan_corrected.png') });
  const nd = store.view().documents.find((d) => d.id === doc.id);
  assert.deepEqual(nd.replaceDiff.readablePages, { from: 0, to: 1 });
  assert.ok(nd.replaceDiff.fields.length >= 1);
});

test('a damaged file with valid magic bytes degrades to unreadable instead of crashing (PNG and PDF)', needOcr, () => {
  const store = mkStore(); const before = tmpLeftovers();
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('garbage-not-an-image'.repeat(20))]);
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('this is not really a pdf'.repeat(20))]);
  store.uploadDocument('claimant', { name: 'broken.png', dataBase64: png.toString('base64') });
  store.uploadDocument('claimant', { name: 'broken.pdf', dataBase64: pdf.toString('base64') });
  for (const n of ['broken.png', 'broken.pdf']) assert.equal(pageOf(store, n).p.readable, false, n);
  assert.equal(tmpLeftovers(), before);
});

test('an OCR value read with low confidence turns a mismatch into "needs review" and says why', () => {
  const store = mkStore();
  const claim = store.state.documents.find((d) => d.name === 'claim_form.txt');
  assert.ok(store.findingsList().some((f) => f.status === 'open' && f.code === 'FIELD_MISMATCH'), 'baseline mismatch exists');
  claim.pages.forEach((pg) => { pg.ocr = { method: 'ocr', engine: 'test', confidence: 60, status: 'verify' }; });
  claim.fields = engine.extractFields(claim);
  store._afterChange(); // same hook every real mutation runs: re-analyse and sync findings
  assert.ok(Object.values(claim.fields).some((f) => f.ocrVerify), 'fields from verify pages are flagged');
  const open = store.findingsList().filter((f) => f.status === 'open');
  assert.ok(!open.some((f) => f.code === 'FIELD_MISMATCH' && /Claimed amount/i.test(f.title || '')), 'amount no longer a hard mismatch');
  const review = open.find((f) => f.code === 'FIELD_NEEDS_REVIEW' && /OCR/.test(f.explanation || f.detail || ''));
  assert.ok(review, 'needs-review finding explains the OCR caveat');
});

test('seeded fixture is unchanged by the OCR feature (determinism)', () => {
  const a = mkStore().view(); const b = withOcrOff(() => mkStore().view());
  assert.deepEqual(a.documents.map((d) => [d.name, d.sha256, d.pages.map((p) => p.readable)]), b.documents.map((d) => [d.name, d.sha256, d.pages.map((p) => p.readable)]));
});
