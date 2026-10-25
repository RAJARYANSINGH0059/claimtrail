'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../src/engine');
const fixtures = require('../src/fixtures');
const { extractRequirements } = require('../src/requirements');
const ai = require('../src/ai');

const mkDoc = (id, name, pages, extra = {}) => {
  const d = { id, name, mime: 'text/plain', size: 1, sha256: engine.sha256(pages.join('\f')), pages: pages.map((text, i) => ({ n: i + 1, text })), supersededBy: null, delivery: { status: 'not_sent' }, ...extra };
  d.classification = engine.classifyDocument(d);
  d.fields = engine.extractFields(d);
  return d;
};
const seedDoc = (name) => { const s = fixtures.SEED_DOCS.find((d) => d.name === name); return mkDoc('X', name, s.pages); };

test('classifies each fixture document type from its text', () => {
  const want = { 'claim_form.txt': 'claim_form', 'hospital_final_bill.txt': 'bill', 'discharge_summary.txt': 'discharge_summary', 'cancelled_cheque.txt': 'bank_proof', 'photo_id.txt': 'id_proof' };
  for (const [name, type] of Object.entries(want)) assert.equal(seedDoc(name).classification.type, type, name);
  for (const s of fixtures.SAMPLES) assert.ok(mkDoc('S', s.name, s.pages).classification.confidence >= 0.75, s.name);
  assert.equal(mkDoc('S', 'lab_report.txt', fixtures.SAMPLES[0].pages).classification.type, 'lab_report');
});

test('field extraction records page and source excerpt (provenance)', () => {
  const bill = seedDoc('hospital_final_bill.txt');
  assert.equal(bill.fields.billTotal.value, '1,42,500');
  assert.equal(bill.fields.billTotal.page, 2);
  assert.match(bill.fields.billTotal.excerpt, /Grand Total/);
  assert.equal(seedDoc('claim_form.txt').fields.claimedAmount.page, 1);
});

test('pageReadable rejects empty, tiny and garbage text', () => {
  assert.equal(engine.pageReadable(''), false);
  assert.equal(engine.pageReadable('too short'), false);
  assert.equal(engine.pageReadable('@#$%^&*()_+{}|:"<>?~`!@#$%^&*()_+{}|:"<>?~`'), false);
  assert.equal(engine.pageReadable('Patient Name: Aarav Mehta, Date of Admission: 2026-09-02'), true);
});

test('compareValues distinguishes match, mismatch, needs_review and not_comparable', () => {
  const c = engine.compareValues;
  assert.equal(c('name', 'Aarav Mehta', 'AARAV  MEHTA'), 'match');
  assert.equal(c('name', 'Aarav Mehta', 'Aarav K Mehta'), 'needs_review');
  assert.equal(c('name', 'A Mehta', 'Aarav Mehta'), 'needs_review');
  assert.equal(c('name', 'Aarav Mehta', 'Priya Nair'), 'mismatch');
  assert.equal(c('name', '', 'Aarav'), 'not_comparable');
  assert.equal(c('date', '2026-09-02', '02/09/2026'), 'match');
  assert.equal(c('date', '2026-09-02', '2026-09-03'), 'mismatch');
  assert.equal(c('date', '2026-09-02', 'sometime'), 'not_comparable');
  assert.equal(c('amount', '1,42,500', '142500.00'), 'match');
  assert.equal(c('amount', '1,24,500', '1,42,500'), 'mismatch');
  assert.equal(c('id', 'POL-1', 'pol-1'), 'match');
  assert.equal(c('id', 'POL-1', 'POL-2'), 'mismatch');
});

test('duplicate detection: exact hash, likely text, not for unrelated, ignores replaced documents', () => {
  const a = seedDoc('discharge_summary.txt');
  const b = mkDoc('B', 'discharge_summary_copy.txt', fixtures.SEED_DOCS.find((d) => d.name === 'discharge_summary_copy.txt').pages);
  const a2 = { ...a, id: 'A' };
  const exact = engine.detectDuplicates([a2, { ...a, id: 'A2', name: 'renamed.txt' }]);
  assert.equal(exact[0].kind, 'exact');
  const likely = engine.detectDuplicates([a2, b]);
  assert.equal(likely[0].kind, 'likely');
  assert.ok(likely[0].score >= 0.85);
  assert.deepEqual(engine.detectDuplicates([a2, seedDoc('hospital_final_bill.txt')]), []);
  assert.deepEqual(engine.detectDuplicates([a2, { ...b, supersededBy: 'D-9' }]), []);
});

test('validateLink flags missing document, page out of range and empty excerpt', () => {
  const d = seedDoc('claim_form.txt');
  assert.equal(engine.validateLink({ docId: 'X', page: 1, excerpt: 'x' }, [d]).valid, true);
  assert.equal(engine.validateLink({ docId: 'X', page: 2, excerpt: 'x' }, [d]).valid, false);
  assert.equal(engine.validateLink({ docId: 'X', page: 0, excerpt: 'x' }, [d]).valid, false);
  assert.equal(engine.validateLink({ docId: 'X', page: 1, excerpt: '  ' }, [d]).valid, false);
  assert.equal(engine.validateLink({ docId: 'NOPE', page: 1, excerpt: 'x' }, [d]).valid, false);
});

test('a link without a valid source becomes a non-overridable provenance blocker and blocks readiness', () => {
  const d = seedDoc('claim_form.txt');
  const reqs = [{ id: 'R-1', label: 'Claim form', category: 'claim_form', required: true }];
  const links = [{ id: 'L1', reqId: 'R-1', docId: 'X', page: 9, excerpt: 'x', confidence: 1, reason: '', decision: 'accepted' }];
  const a = engine.analyze({ requirements: reqs, documents: [d], links });
  assert.ok(a.findings.some((f) => f.code === 'PROVENANCE_MISSING' && f.severity === 'blocker'));
  assert.equal(a.readiness.ready, false);
});

test('missing required evidence yields a REQ_MISSING finding with no citation, and blocks readiness', () => {
  const reqs = [{ id: 'R-1', label: 'Lab report', category: 'lab_report', required: true }];
  const a = engine.analyze({ requirements: reqs, documents: [], links: [] });
  const f = a.findings.find((x) => x.code === 'REQ_MISSING');
  assert.deepEqual(f.evidence, []);
  assert.match(f.explanation, /No active document/);
  assert.equal(a.readiness.ready, false);
  assert.deepEqual(engine.analyze({ requirements: [], documents: [], links: [] }).findings, []);
});

test('two different readable documents for one requirement are ambiguous, not silently chosen', () => {
  const b1 = mkDoc('D-1', 'bill_a.txt', ['RIVERSIDE FINAL BILL\nBill No: A-1\nGrand Total: 100\nRoom charges: 50\nInvoice alpha beta gamma delta epsilon']);
  const b2 = mkDoc('D-2', 'bill_b.txt', ['OTHER HOSPITAL FINAL BILL\nBill No: B-2\nGrand Total: 900\nProcedure charges: 400\nInvoice zeta eta theta iota kappa']);
  const reqs = [{ id: 'R-1', label: 'Final bill', category: 'bill', required: true }];
  const links = engine.suggestLinks(reqs, [b1, b2]).map((s) => ({ ...s, id: `L-${s.reqId}-${s.docId}`, decision: 'suggested' }));
  const a = engine.analyze({ requirements: reqs, documents: [b1, b2], links });
  assert.equal(a.statuses[0].status, 'ambiguous');
  assert.ok(a.findings.some((f) => f.code === 'REQ_AMBIGUOUS'));
});

test('a discrepancy is described as a documentation difference, never as fraud', () => {
  const claim = mkDoc('A', 'claim_form.txt', fixtures.SEED_DOCS[0].pages);
  const bill = mkDoc('B', 'hospital_final_bill.txt', fixtures.SEED_DOCS[1].pages);
  const reqs = [{ id: 'R-1', label: 'Claim form', category: 'claim_form', required: true }, { id: 'R-2', label: 'Bill', category: 'bill', required: true }];
  const links = engine.suggestLinks(reqs, [claim, bill]).map((s) => ({ ...s, id: `L-${s.reqId}-${s.docId}`, decision: 'suggested' }));
  const a = engine.analyze({ requirements: reqs, documents: [claim, bill], links });
  const m = a.findings.find((f) => f.code === 'FIELD_MISMATCH');
  assert.ok(m);
  assert.match(m.explanation, /not a determination of fraud/);
  assert.deepEqual(m.evidence.map((e) => [e.docName, e.page]), [['claim_form.txt', 1], ['hospital_final_bill.txt', 2]]);
  for (const f of a.findings) assert.doesNotMatch(f.title + f.explanation, /fraudulent|fraud detected|likely fraud/i);
});

test('requirement extraction: categories by rule, unknown lines need a category', () => {
  const out = extractRequirements('Intro line\n1. Duly filled claim form\n2) Cancelled cheque\n- Something unusual here\nnot a list line');
  assert.deepEqual(out.map((c) => c.category), ['claim_form', 'bank_proof', null]);
  assert.ok(out.every((c) => c.mode === 'deterministic-rules'));
  assert.equal(extractRequirements(fixtures.REQUEST_LETTER).length, 7);
  assert.deepEqual(extractRequirements(''), []);
});

test('AI adapter validators reject malformed model-style output', () => {
  assert.throws(() => ai.validateClassification({ type: 'made_up', confidence: 0.5, reasons: [], mode: 'x' }));
  assert.throws(() => ai.validateClassification({ type: 'bill', confidence: 2, reasons: [], mode: 'x' }));
  assert.throws(() => ai.validateCandidates([{ label: 'ok label', category: 'not_a_type' }]));
  assert.throws(() => ai.validateDraft({ subject: 1 }));
  assert.equal(ai.providerInfo().live, false);
});
