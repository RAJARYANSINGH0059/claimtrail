'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../src/engine');
const life = require('../src/lifecycle');
const { mkStore, b64, proof, codes, open, reqStatus, toSubmitted, toIntakeReview, rejects } = require('./helpers');

const docByName = (s, name) => s.activeDocs().find((d) => d.name === name);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);

/* ---------- fixture & determinism ---------- */
test('seeded packet covers every required demo situation', () => {
  const s = mkStore();
  assert.equal(s.status, 'preparing');
  assert.equal(reqStatus(s, 'Photo ID').status, 'matched');
  assert.equal(reqStatus(s, 'Hospital final bill').status, 'matched');
  assert.equal(reqStatus(s, 'Diagnostic').status, 'missing');
  assert.equal(reqStatus(s, 'Pharmacy').status, 'unreadable');
  const open_ = codes(s);
  for (const c of ['REQ_MISSING', 'DOC_PAGE_UNREADABLE', 'DUP_LIKELY', 'FIELD_MISMATCH', 'FIELD_NEEDS_REVIEW', 'DELIVERY_PROOF_MISSING']) assert.ok(open_.includes(c), c);
  const cheque = docByName(s, 'cancelled_cheque.txt');
  assert.equal(cheque.delivery.status, 'acknowledged');
  assert.ok(cheque.delivery.ackRef && cheque.delivery.proof.sha256, 'acknowledged item carries proof');
  const id = docByName(s, 'photo_id.txt');
  assert.equal(id.delivery.status, 'sent_claimed');
  assert.equal(id.delivery.proof, undefined, 'the unproven item has no proof');
});

test('every open finding cites a document page or states which evidence is absent', () => {
  const s = mkStore();
  for (const f of s.findingsList().filter((x) => x.status === 'open')) {
    if (f.code === 'REQ_MISSING') { assert.deepEqual(f.evidence, []); assert.match(f.explanation, /No active document/); continue; }
    assert.ok(f.evidence.length >= 1, `${f.code} cites something`);
    for (const e of f.evidence) {
      const d = s.state.documents.find((x) => x.id === e.docId);
      assert.ok(d, `${f.code} cites a real document`);
      assert.ok(e.page >= 1 && e.page <= d.pages.length, `${f.code} cites a real page`);
    }
  }
});

test('reset restores the exact original fixture and is deterministic across stores', () => {
  const a = mkStore();
  const before = JSON.stringify(a.snapshot('reviewer'));
  toIntakeReview(a);
  a.addSample('reviewer', { sampleId: 'S-CLAIM-FIX' });
  assert.notEqual(JSON.stringify(a.snapshot('reviewer')), before);
  a.reset();
  assert.equal(JSON.stringify(a.snapshot('reviewer')), before);
  assert.equal(JSON.stringify(mkStore().snapshot('reviewer')), before, 'a second store seeds identically');
  assert.equal(a.status, 'preparing');
  assert.equal(a.state.submissions.length, 0);
});

test('event log is append-only: earlier events never change, sequence increases, failed calls add nothing', () => {
  const s = mkStore();
  const snap0 = JSON.parse(JSON.stringify(s.state.events));
  s.addSample('claimant', { sampleId: 'S-LAB' });
  s.createDraft('claimant', 'follow_up');
  const now = s.state.events;
  assert.deepEqual(JSON.parse(JSON.stringify(now.slice(0, snap0.length))), snap0);
  assert.ok(now.length > snap0.length);
  now.forEach((e, i) => assert.equal(e.seq, i + 1));
  const len = now.length;
  rejects(() => s.transition('claimant', 'submitted', { proof: {} }), 'INVALID_TRANSITION');
  rejects(() => s.uploadDocument('claimant', { name: 'x.exe', dataBase64: b64('x') }), 'UNSUPPORTED_FILE_TYPE');
  assert.equal(s.state.events.length, len);
  assert.equal(typeof s.deleteEvent, 'undefined');
  assert.equal(typeof s.clearEvents, 'undefined');
});

/* ---------- readiness & proof gates ---------- */
test('missing required evidence blocks readiness; adding it unblocks', () => {
  const s = mkStore();
  const e = rejects(() => s.transition('claimant', 'ready_for_review'), 'TRANSITION_BLOCKED', 422);
  assert.ok(e.details.reasons.some((r) => /Diagnostic/.test(r)));
  assert.equal(s.status, 'preparing');
  assert.equal(s.snapshot('claimant').transitions[0].allowed, false);
  s.addSample('claimant', { sampleId: 'S-LAB' });
  assert.equal(s.snapshot('claimant').transitions[0].allowed, true);
  s.transition('claimant', 'ready_for_review');
  assert.equal(s.status, 'ready_for_review');
});

test('Submitted is refused without proof, with a malformed reference, without a file, or with a reused reference', () => {
  const s = mkStore();
  s.addSample('claimant', { sampleId: 'S-LAB' });
  s.transition('claimant', 'ready_for_review');
  rejects(() => s.transition('claimant', 'submitted'), 'PROOF_REQUIRED', 422);
  rejects(() => s.transition('claimant', 'submitted', { proof: { reference: 'x' } }), 'PROOF_REQUIRED');
  const noFile = rejects(() => s.transition('claimant', 'submitted', { proof: { reference: 'SUB-OK-0001' } }), 'PROOF_REQUIRED');
  assert.ok(noFile.details.reasons.some((r) => /proof file/.test(r)));
  assert.equal(s.status, 'ready_for_review');
  assert.equal(s.state.submissions.length, 0);
  s.transition('claimant', 'submitted', { proof: proof('SUB-OK-0001') });
  assert.equal(s.status, 'submitted');
  assert.equal(s.state.submissions.length, 1);
  assert.equal(s.state.submissions[0].proof.sha256.length, 64);
});

test('Resubmitted needs proof AND new evidence since the correction request; references cannot be reused', () => {
  const s = toIntakeReview(mkStore());
  s.transition('reviewer', 'action_required');
  assert.equal(s.status, 'action_required');
  const e = rejects(() => s.transition('claimant', 'resubmitted', { proof: proof('SUB-TEST-0002') }), 'TRANSITION_BLOCKED');
  assert.ok(e.details.reasons.some((r) => /No new, replaced or withdrawn evidence/.test(r)));
  s.addSample('claimant', { sampleId: 'S-CLAIM-FIX' });
  rejects(() => s.transition('claimant', 'resubmitted'), 'PROOF_REQUIRED');
  const reuse = rejects(() => s.transition('claimant', 'resubmitted', { proof: proof('sub-test-0001') }), 'PROOF_REQUIRED');
  assert.ok(reuse.details.reasons.some((r) => /already used/.test(r)));
  s.transition('claimant', 'resubmitted', { proof: proof('SUB-TEST-0002') });
  assert.equal(s.status, 'resubmitted');
  assert.equal(s.state.submissions.length, 2);
  assert.equal(s.state.submissions[1].kind, 'resubmission');
});

test('Acknowledged needs a reference and a proof file; "sent" is only a claim', () => {
  const s = mkStore();
  const id = docByName(s, 'photo_id.txt');
  assert.ok(codes(s).includes('DELIVERY_PROOF_MISSING'));
  rejects(() => s.setDelivery('claimant', id.id, { status: 'acknowledged' }), 'PROOF_REFERENCE_INVALID');
  rejects(() => s.setDelivery('claimant', id.id, { status: 'acknowledged', reference: 'ACK-1' }), 'PROOF_REFERENCE_INVALID');
  rejects(() => s.setDelivery('claimant', id.id, { status: 'acknowledged', reference: 'ACK-TEST-0001' }), 'PROOF_FILE_REQUIRED');
  rejects(() => s.setDelivery('claimant', id.id, { status: 'delivered' }), 'DELIVERY_INVALID');
  assert.equal(docByName(s, 'photo_id.txt').delivery.status, 'sent_claimed');
  s.setDelivery('claimant', id.id, { status: 'acknowledged', reference: 'ACK-TEST-0001', fileName: 'ack.txt', dataBase64: b64('SYNTHETIC ACK') });
  assert.equal(docByName(s, 'photo_id.txt').delivery.status, 'acknowledged');
  assert.ok(!codes(s).includes('DELIVERY_PROOF_MISSING'), 'warning clears once proof exists');
});

/* ---------- findings: duplicates, mismatch, unreadable, provenance ---------- */
test('exact duplicate upload (same bytes, new name) is flagged DUP_EXACT; likely duplicate fixture is DUP_LIKELY', () => {
  const s = mkStore();
  const text = docByName(s, 'cancelled_cheque.txt').pages.map((p) => p.text).join('\f');
  s.uploadDocument('claimant', { name: 'cheque_again.txt', dataBase64: b64(text) });
  assert.ok(codes(s).includes('DUP_EXACT'));
  assert.ok(codes(s).includes('DUP_LIKELY'));
  const f = open(s, 'DUP_LIKELY');
  assert.deepEqual(f.evidence.map((e) => e.docName).sort(), ['discharge_summary.txt', 'discharge_summary_copy.txt']);
  assert.match(f.explanation, /not a finding of misconduct/);
});

test('cross-document mismatch cites both pages, is never called fraud, and clears when corrected evidence arrives', () => {
  const s = mkStore();
  const f = open(s, 'FIELD_MISMATCH');
  assert.equal(f.severity, 'blocker');
  assert.deepEqual(f.evidence.map((e) => [e.docName, e.page]), [['claim_form.txt', 1], ['hospital_final_bill.txt', 2]]);
  const cmp = s.view().comparisons.find((c) => c.status === 'mismatch');
  assert.deepEqual([cmp.ref.value, cmp.other.value], ['1,24,500', '1,42,500']);
  for (const x of s.findingsList()) assert.doesNotMatch(`${x.title} ${x.explanation}`, /fraudulent|fraud detected|likely fraud|forged|fake/i);
  s.addSample('claimant', { sampleId: 'S-CLAIM-FIX' });
  assert.equal(open(s, 'FIELD_MISMATCH'), undefined);
  const resolved = s.findingsList().find((x) => x.code === 'FIELD_MISMATCH');
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolution.kind, 'evidence_changed');
  assert.ok(resolved.history.length >= 2, 'history is preserved');
});

test('name needs-review vs match vs not-comparable are distinct comparison results', () => {
  const s = mkStore();
  const byStatus = (st) => s.view().comparisons.filter((c) => c.status === st).map((c) => c.field);
  assert.ok(byStatus('match').includes('policyNo'));
  assert.ok(byStatus('needs_review').includes('patientName'));
  assert.ok(byStatus('not_comparable').includes('patientName'));
  s.addSample('claimant', { sampleId: 'S-ID-FIX' });
  assert.equal(open(s, 'FIELD_NEEDS_REVIEW'), undefined);
});

test('unreadable scan is flagged; a real PNG upload counts as unreadable (no OCR); replacing it shows a re-upload diff', () => {
  const s = mkStore();
  assert.match(open(s, 'DOC_PAGE_UNREADABLE').title, /pharmacy_bill_scan\.png/);
  s.uploadDocument('claimant', { name: 'extra_scan.png', dataBase64: PNG.toString('base64') });
  assert.ok(s.findingsList().some((f) => f.status === 'open' && f.code === 'DOC_PAGE_UNREADABLE' && /extra_scan\.png/.test(f.title)));
  const d = s.addSample('claimant', { sampleId: 'S-PHARM' });
  assert.equal(d.replaces, docByName(s, 'pharmacy_bill_readable.txt').replaces);
  assert.equal(d.replaceDiff.readablePages.from, 0);
  assert.equal(d.replaceDiff.readablePages.to, 1);
  assert.ok(d.replaceDiff.hashChanged);
  assert.equal(reqStatus(s, 'Pharmacy').status, 'matched');
  assert.ok(!s.findingsList().some((f) => f.status === 'open' && /pharmacy_bill_scan/.test(f.title)));
  assert.equal(s.state.documents.find((x) => x.name === 'pharmacy_bill_scan.png').supersededBy, d.id, 'old version kept in history');
});

test('re-upload diff reports changed fields; identical re-upload is refused; replacing a missing document is a 404', () => {
  const s = mkStore();
  const old = docByName(s, 'claim_form.txt');
  const d = s.addSample('claimant', { sampleId: 'S-CLAIM-FIX' });
  const ch = d.replaceDiff.fields.find((f) => f.field === 'claimedAmount');
  assert.deepEqual([ch.from, ch.to, ch.change], ['1,24,500', '1,42,500', 'changed']);
  assert.ok(d.replaceDiff.unchangedFields >= 4);
  const same = old.pages.map((p) => p.text).join('\f');
  const cur = docByName(s, 'claim_form_corrected.txt');
  const fresh = Buffer.from(cur.pages.map((p) => p.text).join('\f'));
  // identical bytes to the current version => refused
  s.state.documents.find((x) => x.id === cur.id).sha256 = engine.sha256(fresh);
  rejects(() => s.uploadDocument('claimant', { name: 'claim_form_corrected.txt', dataBase64: fresh.toString('base64'), replaces: cur.id }), 'REUPLOAD_IDENTICAL');
  rejects(() => s.uploadDocument('claimant', { name: 'a.txt', dataBase64: b64(same), replaces: 'D-999' }), 'DOC_NOT_FOUND', 404);
  rejects(() => s.uploadDocument('claimant', { name: 'claim_form_corrected.txt', dataBase64: b64('x y z') }), 'NAME_EXISTS', 409);
});

test('provenance: accepted matches need a valid page and excerpt; forged links are refused and become a non-overridable blocker', () => {
  const s = toIntakeReview(mkStore());
  s.acceptSuggested('reviewer');
  for (const l of s.state.links.filter((x) => x.decision === 'accepted')) assert.equal(engine.validateLink(l, s.state.documents).valid, true, l.id);
  const bad = s.state.links.find((x) => x.reqId === 'R-2');
  Object.assign(bad, { decision: 'rejected', page: 42 });
  rejects(() => s.decideLink('reviewer', bad.id, { decision: 'accepted' }), 'PROVENANCE_INVALID', 422);
  const forged = s.state.links.find((x) => x.reqId === 'R-1');
  Object.assign(forged, { decision: 'accepted', page: 42 });
  s._afterChange();
  const f = open(s, 'PROVENANCE_MISSING');
  assert.ok(f, 'missing provenance is visible');
  rejects(() => s.resolveFinding('reviewer', f.key, { note: 'ignore this please' }), 'NOT_OVERRIDABLE');
  assert.equal(s.analysis().readiness.ready, false);
  rejects(() => s.manualLink('claimant', { reqId: 'R-1', docId: docByName(s, 'claim_form.txt').id, page: 5 }), 'WRONG_STATE', 409);
});

test('manual link needs a real page of a real document', () => {
  const s = mkStore();
  const d = docByName(s, 'hospital_final_bill.txt');
  rejects(() => s.manualLink('claimant', { reqId: 'R-4', docId: d.id, page: 3 }), 'PROVENANCE_INVALID', 422);
  rejects(() => s.manualLink('claimant', { reqId: 'R-99', docId: d.id, page: 1 }), 'REQUIREMENT_NOT_FOUND', 404);
  const l = s.manualLink('claimant', { reqId: 'R-4', docId: d.id, page: 2 });
  assert.equal(l.page, 2);
  assert.ok(l.excerpt.length > 0);
  assert.equal(reqStatus(s, 'Diagnostic').status, 'matched', 'manual choice satisfies the requirement, with a source');
});

/* ---------- reviewer actions ---------- */
test('reviewer override requires a note; the override, note and history are kept', () => {
  const s = toIntakeReview(mkStore());
  const f = open(s, 'DUP_LIKELY');
  rejects(() => s.resolveFinding('reviewer', f.key, {}), 'NOTE_REQUIRED', 422);
  rejects(() => s.resolveFinding('reviewer', f.key, { note: 'ok' }), 'NOTE_REQUIRED');
  rejects(() => s.resolveFinding('reviewer', f.key, { note: ' '.repeat(10) }), 'NOTE_REQUIRED');
  assert.equal(open(s, 'DUP_LIKELY').key, f.key, 'failed attempts changed nothing');
  s.resolveFinding('reviewer', f.key, { note: 'Same discharge summary; patient copy ignored.' });
  const r = s.findingsList().find((x) => x.key === f.key);
  assert.equal(r.status, 'resolved');
  assert.equal(r.resolution.kind, 'reviewer_note');
  assert.equal(r.resolution.by, 'reviewer');
  s._afterChange();
  assert.equal(s.findingsList().find((x) => x.key === f.key).status, 'resolved', 'override persists across re-checks');
  rejects(() => s.resolveFinding('reviewer', f.key, { note: 'again please' }), 'FINDING_NOT_OPEN', 409);
  rejects(() => s.reopenFinding('reviewer', f.key, {}), 'NOTE_REQUIRED');
  s.reopenFinding('reviewer', f.key, { note: 'Needs a second look.' });
  const again = s.findingsList().find((x) => x.key === f.key);
  assert.equal(again.status, 'open');
  assert.equal(again.reopenCount, 1);
  assert.deepEqual(again.history.map((h) => h.action), ['opened', 'resolved', 'reopened']);
});

test('rejecting a match needs a reason and the rejected pair is not re-suggested', () => {
  const s = toIntakeReview(mkStore());
  const link = s.state.links.find((l) => l.reqId === 'R-1');
  rejects(() => s.decideLink('reviewer', link.id, { decision: 'rejected' }), 'NOTE_REQUIRED');
  s.decideLink('reviewer', link.id, { decision: 'rejected', note: 'Wrong form version.' });
  s._afterChange();
  assert.equal(reqStatus(s, 'claim form').status, 'missing');
  assert.equal(s.state.links.find((l) => l.id === link.id).decision, 'rejected');
  assert.ok(codes(s).includes('REQ_MISSING'));
});

test('intake complete is refused while blockers are open or matches are unconfirmed, and the report says why', () => {
  const s = toIntakeReview(mkStore());
  const e = rejects(() => s.transition('reviewer', 'intake_complete'), 'TRANSITION_BLOCKED', 422);
  assert.ok(e.details.reasons.some((r) => /FIELD_MISMATCH/.test(r)));
  assert.equal(s.status, 'intake_review');
  const rep = JSON.parse(s.report('reviewer', 'json').body);
  assert.equal(rep.outcome.complete, false);
  assert.match(rep.outcome.explanation, /NOT complete/);
  assert.match(rep.notice, /not a coverage decision/);
  assert.ok(rep.openFindings.some((f) => f.code === 'FIELD_MISMATCH' && f.citations.length === 2));
});

test('full loop: submit, review, request corrections, correct, resubmit, intake checks complete (not a coverage decision)', () => {
  const s = toIntakeReview(mkStore());
  assert.equal(s.status, 'intake_review');
  s.acceptSuggested('reviewer');
  s.transition('reviewer', 'action_required');
  assert.equal(s.status, 'action_required');
  const draft = s.state.drafts.find((d) => d.kind === 'correction_request');
  assert.ok(draft && draft.sent === false && /not sent|did not send/i.test(draft.body));
  assert.match(draft.body, /not a coverage decision/);
  s.addSample('claimant', { sampleId: 'S-CLAIM-FIX' });
  s.addSample('claimant', { sampleId: 'S-ID-FIX' });
  s.withdrawDocument('claimant', docByName(s, 'discharge_summary_copy.txt').id, { reason: 'Unwanted duplicate copy.' });
  s.transition('claimant', 'resubmitted', { proof: proof('SUB-TEST-0002') });
  s.rerun('reviewer');
  s.acceptSuggested('reviewer');
  assert.deepEqual(s.openBlocking().map((f) => f.code), [], 'only info-level items remain');
  s.transition('reviewer', 'intake_complete');
  assert.equal(s.status, 'intake_complete');
  const rep = JSON.parse(s.report('reviewer', 'json').body);
  assert.equal(rep.outcome.complete, true);
  assert.ok(rep.resolvedFindings.length >= 3);
  assert.match(rep.notice, /not a coverage decision/);
  assert.equal(s.snapshot('claimant').transitions.length, 0);
  rejects(() => s.addSample('claimant', { sampleId: 'S-LAB' }), 'WRONG_STATE', 409);
});

test('a claimant-confirmed match does not satisfy intake completion; only the reviewer can confirm', () => {
  const s = toIntakeReview(mkStore());
  s.addSample('reviewer', { sampleId: 'S-CLAIM-FIX' });
  s.addSample('reviewer', { sampleId: 'S-ID-FIX' });
  const dup = open(s, 'DUP_LIKELY');
  s.resolveFinding('reviewer', dup.key, { note: 'Same document, patient copy.' });
  assert.deepEqual(s.openBlocking().map((f) => f.code), []);
  for (const l of s.state.links) if (l.decision === 'suggested') Object.assign(l, { decision: 'accepted', decidedBy: 'claimant' });
  const e = rejects(() => s.transition('reviewer', 'intake_complete'), 'TRANSITION_BLOCKED', 422);
  assert.ok(e.details.reasons.every((r) => /confirmed by the reviewer/.test(r)), JSON.stringify(e.details.reasons));
  assert.ok(e.details.reasons.length >= 5);
  s.acceptSuggested('reviewer');
  s.transition('reviewer', 'intake_complete');
  assert.equal(s.status, 'intake_complete');
});

test('re-run reports new / resolved / still-open findings', () => {
  const s = toIntakeReview(mkStore());
  const first = s.rerun('reviewer');
  assert.ok(first.diff.newlyOpen.length > 0);
  s.addSample('reviewer', { sampleId: 'S-CLAIM-FIX' });
  const second = s.rerun('reviewer');
  assert.ok(second.diff.resolved.some((k) => /FIELD_MISMATCH/.test(k)));
  assert.ok(second.diff.stillOpen.length > 0);
});

/* ---------- roles & permissions ---------- */
test('role-specific access is enforced by the store, not only the UI', () => {
  const s = mkStore();
  rejects(() => s.resolveFinding('claimant', open(s, 'DUP_LIKELY').key, { note: 'claimant tries it' }), 'FORBIDDEN_ROLE', 403);
  rejects(() => s.rerun('claimant'), 'FORBIDDEN_ROLE', 403);
  rejects(() => s.queue('claimant'), 'FORBIDDEN_ROLE', 403);
  rejects(() => s.dashboard('claimant'), 'FORBIDDEN_ROLE', 403);
  rejects(() => s.report('claimant', 'md'), 'FORBIDDEN_ROLE', 403);
  rejects(() => s.createDraft('reviewer', 'follow_up'), 'FORBIDDEN_ROLE', 403);
  rejects(() => s.addRequirement('reviewer', { label: 'Extra thing', category: 'bill' }), 'FORBIDDEN_ROLE', 403);
  rejects(() => s.acceptSuggested('claimant'), 'FORBIDDEN_ROLE', 403);
  rejects(() => s.snapshot('admin'), 'FORBIDDEN_ROLE', 403);
  rejects(() => s.transition('reviewer', 'ready_for_review'), 'FORBIDDEN_ROLE', 403);
  rejects(() => s.transition('claimant', 'intake_complete'), 'INVALID_TRANSITION', 409);
  rejects(() => s.resolveFinding('reviewer', open(s, 'DUP_LIKELY').key, { note: 'too early, still preparing' }), 'WRONG_STATE', 409);
  const caps = s.snapshot('claimant').can;
  assert.equal(caps['finding.resolve'], false);
  assert.equal(caps['document.add'], true);
  const rcaps = s.snapshot('reviewer').can;
  assert.equal(rcaps['document.add'], false, 'reviewer cannot change the claimant packet while it is being prepared');
});

test('claimant packet is frozen after submission; reviewer can add intake evidence only in review phases', () => {
  const s = toSubmitted(mkStore());
  rejects(() => s.addSample('claimant', { sampleId: 'S-CLAIM-FIX' }), 'WRONG_STATE', 409);
  rejects(() => s.withdrawDocument('claimant', docByName(s, 'claim_form.txt').id, { reason: 'trying to edit' }), 'WRONG_STATE', 409);
  rejects(() => s.addSample('reviewer', { sampleId: 'S-CLAIM-FIX' }), 'WRONG_STATE', 409);
  s.transition('reviewer', 'intake_review');
  s.addSample('reviewer', { sampleId: 'S-CLAIM-FIX' });
  assert.equal(docByName(s, 'claim_form_corrected.txt').addedBy, 'reviewer');
});

test('lifecycle table: every state is reachable, only the suggested transitions exist, proof is on both submissions', () => {
  const targets = new Set(life.TRANSITIONS.map((t) => t.to));
  for (const [id] of life.STATES) if (id !== 'draft') assert.ok(targets.has(id), id);
  for (const t of life.TRANSITIONS.filter((x) => x.to === 'submitted' || x.to === 'resubmitted')) assert.ok(t.guards.includes('proof'), t.to);
  for (const t of life.TRANSITIONS.filter((x) => x.to === 'intake_complete')) assert.ok(t.guards.includes('noBlockers') && t.guards.includes('confirmed'));
  assert.equal(life.TRANSITIONS.some((t) => t.to === 'acknowledged'), false);
  assert.match(life.LABELS.intake_complete, /Intake checks complete/);
  assert.doesNotMatch(Object.values(life.LABELS).join(' '), /approv|settled|paid|accepted claim/i);
});

/* ---------- input validation, empty & error states ---------- */
test('upload validation: type, empty, size, encoding, name, content mismatch, limits', () => {
  const s = mkStore();
  const up = (o) => s.uploadDocument('claimant', o);
  rejects(() => up({ name: 'malware.exe', dataBase64: b64('MZ') }), 'UNSUPPORTED_FILE_TYPE', 415);
  rejects(() => up({ name: 'noext', dataBase64: b64('x') }), 'UNSUPPORTED_FILE_TYPE');
  rejects(() => up({ name: 'a.txt', dataBase64: '' }), 'FILE_EMPTY', 422);
  rejects(() => up({ name: 'a.txt' }), 'FILE_EMPTY');
  rejects(() => up({ name: 'a.txt', dataBase64: '!!!notbase64' }), 'FILE_ENCODING_INVALID', 422);
  rejects(() => up({ name: '', dataBase64: b64('x') }), 'FILE_NAME_INVALID', 422);
  rejects(() => up({ name: 'big.txt', dataBase64: Buffer.alloc(1_100_000, 97).toString('base64') }), 'FILE_TOO_LARGE', 413);
  rejects(() => up({ name: 'fake.png', dataBase64: b64('this is not a png') }), 'FILE_CONTENT_MISMATCH', 415);
  rejects(() => up({ name: 'bin.txt', dataBase64: Buffer.from([65, 0, 66]).toString('base64') }), 'FILE_CONTENT_MISMATCH');
  const d = up({ name: '../../etc/passwd.txt', dataBase64: b64('safe name check') });
  assert.equal(d.name, 'passwd.txt', 'path components are stripped');
  const html = up({ name: 'note<script>.txt', dataBase64: b64('<script>alert(1)</script> plain text') });
  assert.doesNotMatch(html.name, /[<>]/);
});

test('requirement validation and editable checklist', () => {
  const s = mkStore();
  rejects(() => s.addRequirement('claimant', { label: 'x', category: 'bill' }), 'REQUIREMENT_INVALID', 422);
  rejects(() => s.addRequirement('claimant', { label: 'Valid label', category: 'nope' }), 'REQUIREMENT_INVALID');
  rejects(() => s.addRequirement('claimant', { label: 'x'.repeat(81), category: 'bill' }), 'REQUIREMENT_INVALID', 422);
  rejects(() => s.addRequirement('claimant', { label: 'Duly filled and signed claim form', category: 'claim_form' }), 'REQUIREMENT_EXISTS', 409);
  const r = s.addRequirement('claimant', { label: 'Referral letter', category: 'discharge_summary', required: false });
  assert.equal(r.required, false);
  s.updateRequirement('claimant', r.id, { label: 'Referral letter (if any)', required: true });
  assert.equal(s.state.requirements.find((x) => x.id === r.id).label, 'Referral letter (if any)');
  rejects(() => s.updateRequirement('claimant', 'R-404', { label: 'Whatever' }), 'REQUIREMENT_NOT_FOUND', 404);
  rejects(() => s.updateRequirement('claimant', r.id, { required: 'yes' }), 'REQUIREMENT_INVALID');
});

test('empty states: no requirements and no documents still produce a valid view', () => {
  const s = mkStore();
  for (const r of s.state.requirements.slice()) s.removeRequirement('claimant', r.id);
  assert.deepEqual(s.view().statuses, []);
  assert.equal(s.analysis().readiness.ready, true);
  for (const d of s.activeDocs()) s.withdrawDocument('claimant', d.id, { reason: 'clearing the packet' });
  const v = s.snapshot('claimant');
  assert.equal(v.documents.filter((d) => !d.supersededBy).length, 0);
  assert.deepEqual(v.comparisons, []);
  assert.deepEqual(s.manifest('claimant', 'json').body.includes('"requirements": []'), true);
  assert.match(s.missingChecklist('claimant', 'md').body, /All requirements have linked, readable evidence/);
});

/* ---------- exports, drafts, dashboard, AI mode ---------- */
test('exports are not submissions and carry provenance; missing checklist lists what to fix', () => {
  const s = mkStore();
  const status = s.status;
  const m = JSON.parse(s.manifest('claimant', 'json').body);
  assert.equal(s.status, status, 'export does not change the status');
  assert.equal(s.state.submissions.length, 0, 'export is not a submission');
  assert.match(m.notice, /NOT a submission/);
  assert.equal(m.case.submissionProofOnFile, false);
  const bill = m.requirements.find((r) => /Hospital final bill/.test(r.label));
  assert.equal(bill.evidence.provenanceValid, true);
  assert.equal(bill.evidence.sha256.length, 64);
  const md = s.manifest('claimant', 'md').body;
  assert.match(md, /Packet manifest/);
  const miss = s.missingChecklist('claimant', 'md').body;
  assert.match(miss, /Diagnostic/);
  assert.match(miss, /Pharmacy/);
  assert.match(miss, /not a submission/);
  assert.ok(s.state.events.some((e) => e.type === 'export_generated'));
});

test('drafts are text only, labelled not sent, built from a fixed template; no send capability exists', () => {
  const s = mkStore();
  const d = s.createDraft('claimant', 'follow_up');
  assert.equal(d.sent, false);
  assert.equal(d.mode, 'template');
  assert.match(d.body, /did not send/);
  assert.match(d.body, /Diagnostic/);
  assert.doesNotMatch(d.body, /fraud/i);
  rejects(() => s.createDraft('claimant', 'spam'), 'DRAFT_KIND_INVALID', 422);
  for (const k of Object.getOwnPropertyNames(Object.getPrototypeOf(s))) assert.doesNotMatch(k, /^(send|email|post)/i, `no ${k} method`);
});

test('analysis mode is truthfully reported as deterministic rules with no live model', () => {
  const s = mkStore();
  const snap = s.snapshot('claimant');
  assert.equal(snap.meta.ai.live, false);
  assert.equal(snap.meta.ai.mode, 'deterministic-rules');
  assert.match(snap.meta.ai.note, /No external model/);
  assert.ok(snap.documents.every((d) => d.classification.mode === 'deterministic-rules'));
  const c = s.extractCandidates('claimant', 'Request\n1. Duly filled claim form');
  assert.equal(c.live, false);
  rejects(() => s.extractCandidates('claimant', ''), 'TEXT_REQUIRED');
  rejects(() => s.extractCandidates('reviewer', 'x'), 'FORBIDDEN_ROLE');
});

test('dashboard figures are labelled synthetic and the queue marks demo data', () => {
  const s = mkStore();
  const d = s.dashboard('reviewer');
  assert.equal(d.synthetic, true);
  assert.match(d.banner, /SYNTHETIC/);
  assert.equal(d.tiles.length, 4);
  assert.deepEqual(d.tiles.map((t) => t.id), ['first_pass', 'repeat', 'ageing', 'triage']);
  const q = s.queue('reviewer');
  assert.equal(q.demoData, true);
  assert.equal(q.rows[0].live, true);
  assert.ok(q.rows.slice(1).every((r) => r.live === false && /Synthetic/.test(r.claimant)));
});

test('persistence round-trips and a corrupt file falls back to the fixture with a notice', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-'));
  const file = path.join(dir, 'state.json');
  const a = mkStore({ file });
  a.addSample('claimant', { sampleId: 'S-LAB' });
  const b = mkStore({ file });
  assert.equal(b.activeDocs().length, a.activeDocs().length);
  fs.writeFileSync(file, '{not json');
  const c = mkStore({ file });
  assert.equal(c.activeDocs().length, 7);
  assert.match(c.startupNotice, /fixture was restored/);
  fs.rmSync(dir, { recursive: true, force: true });
});
