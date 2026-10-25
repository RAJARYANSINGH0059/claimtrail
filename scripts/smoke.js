'use strict';
/** API smoke test against the REAL server process (npm start equivalent), full claimant -> reviewer -> correction -> resubmission -> report loop. */
const assert = require('node:assert/strict');
const { startServer, reporter } = require('./lib');
const r = reporter('smoke (API)');
const b64 = (s) => Buffer.from(s).toString('base64');

(async () => {
  const srv = await startServer();
  const api = async (method, p, role, body) => {
    const res = await fetch(srv.url + p, { method, headers: { 'X-Role': role, ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }) }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* download */ }
    return { status: res.status, json, text };
  };
  const state = async (role = 'claimant') => (await api('GET', '/api/state', role)).json;
  const proof = (ref) => ({ reference: ref, fileName: 'receipt_synthetic.txt', dataBase64: b64('SYNTHETIC RECEIPT ' + ref) });
  const open = (st, code) => st.findings.find((f) => f.status === 'open' && f.code === code);
  try {
    await r.step('server starts and serves the UI shell', async () => {
      const res = await fetch(srv.url + '/');
      assert.equal(res.status, 200);
      assert.match(await res.text(), /DEMO DATA/);
    });
    await r.step('seeded case: missing, unreadable, duplicate, mismatch, ack-with-proof, no-proof item', async () => {
      const st = await state();
      for (const c of ['REQ_MISSING', 'DOC_PAGE_UNREADABLE', 'DUP_LIKELY', 'FIELD_MISMATCH']) assert.ok(open(st, c), c);
      assert.equal(st.documents.find((d) => d.name === 'cancelled_cheque.txt').delivery.status, 'acknowledged');
      assert.equal(st.documents.find((d) => d.name === 'photo_id.txt').delivery.status, 'sent_claimed');
      assert.equal(st.case.status, 'preparing');
    });
    await r.step('readiness is blocked by the missing required report', async () => {
      const x = await api('POST', '/api/transition', 'claimant', { to: 'ready_for_review' });
      assert.equal(x.status, 422);
      assert.match(JSON.stringify(x.json.error.details.reasons), /Diagnostic/);
    });
    await r.step('claimant adds the sample lab report, marks ready, and Submitted is refused without proof', async () => {
      assert.equal((await api('POST', '/api/documents/sample', 'claimant', { sampleId: 'S-LAB' })).status, 200);
      assert.equal((await api('POST', '/api/transition', 'claimant', { to: 'ready_for_review' })).status, 200);
      const no = await api('POST', '/api/transition', 'claimant', { to: 'submitted' });
      assert.equal(no.status, 422);
      assert.equal(no.json.error.code, 'PROOF_REQUIRED');
      assert.equal((await state()).case.status, 'ready_for_review');
    });
    await r.step('claimant exports manifest + missing checklist and drafts a follow-up; none of it changes status', async () => {
      const m = await api('GET', '/api/export/manifest?format=json', 'claimant');
      assert.match(JSON.parse(m.text).notice, /NOT a submission/);
      assert.match((await api('GET', '/api/export/missing?format=md', 'claimant')).text, /Pharmacy/);
      const d = await api('POST', '/api/drafts', 'claimant', { kind: 'follow_up' });
      assert.equal(d.json.sent, false);
      assert.equal((await state()).case.status, 'ready_for_review');
    });
    await r.step('submission recorded with proof', async () => {
      const ok = await api('POST', '/api/transition', 'claimant', { to: 'submitted', proof: proof('SUB-SMOKE-0001') });
      assert.equal(ok.status, 200);
      assert.equal((await state()).submissions.length, 1);
    });
    await r.step('reviewer starts intake review; claimant is blocked from reviewer actions', async () => {
      assert.equal((await api('POST', '/api/transition', 'claimant', { to: 'intake_review' })).status, 403);
      assert.equal((await api('POST', '/api/transition', 'reviewer', { to: 'intake_review' })).status, 200);
      assert.equal((await api('POST', '/api/rerun', 'claimant', {})).status, 403);
    });
    await r.step('reviewer accepts clean matches; override without a note is refused; with a note it is recorded', async () => {
      assert.equal((await api('POST', '/api/links/accept-suggested', 'reviewer', {})).status, 200);
      const st = await state('reviewer');
      const dup = open(st, 'DUP_LIKELY');
      assert.equal((await api('POST', '/api/findings/resolve', 'reviewer', { key: dup.key, note: '' })).status, 422);
      assert.equal((await api('POST', '/api/findings/resolve', 'reviewer', { key: dup.key, note: 'Patient copy of the same summary; ignored.' })).status, 200);
    });
    await r.step('intake checks complete is refused while the mismatch is open', async () => {
      const x = await api('POST', '/api/transition', 'reviewer', { to: 'intake_complete' });
      assert.equal(x.status, 422);
      assert.match(JSON.stringify(x.json.error.details.reasons), /FIELD_MISMATCH/);
    });
    await r.step('reviewer requests corrections (draft only, nothing sent)', async () => {
      assert.equal((await api('POST', '/api/transition', 'reviewer', { to: 'action_required' })).status, 200);
      const st = await state();
      const d = st.drafts.find((x) => x.kind === 'correction_request');
      assert.ok(d && d.sent === false);
      assert.match(d.body, /not a coverage decision/);
    });
    await r.step('resubmission refused without new evidence, then accepted after corrections and proof', async () => {
      const no = await api('POST', '/api/transition', 'claimant', { to: 'resubmitted', proof: proof('SUB-SMOKE-0002') });
      assert.equal(no.status, 422);
      assert.match(JSON.stringify(no.json.error.details.reasons), /No new/);
      const rep = await api('POST', '/api/documents/sample', 'claimant', { sampleId: 'S-PHARM' });
      assert.equal(rep.json.replaceDiff.readablePages.to, 1);
      assert.equal((await api('POST', '/api/documents/sample', 'claimant', { sampleId: 'S-ID-FIX' })).status, 200);
      assert.equal((await api('POST', '/api/transition', 'claimant', { to: 'resubmitted', proof: proof('SUB-SMOKE-0002') })).status, 200);
    });
    await r.step('the intentional failure case stays unresolved and the report explains why', async () => {
      await api('POST', '/api/rerun', 'reviewer', {});
      await api('POST', '/api/links/accept-suggested', 'reviewer', {});
      const st = await state('reviewer');
      assert.ok(open(st, 'FIELD_MISMATCH'));
      const rep = await api('GET', '/api/report?format=json', 'reviewer');
      const j = JSON.parse(rep.text);
      assert.equal(j.outcome.complete, false);
      assert.match(j.outcome.explanation, /NOT complete/);
      assert.ok(j.openFindings.some((f) => f.code === 'FIELD_MISMATCH' && f.citations.length === 2));
      assert.ok(j.resolvedFindings.length >= 3);
    });
    await r.step('state persists across a real server restart', async () => {
      const before = await state();
      await srv.restart();
      const after = await state();
      assert.equal(after.case.status, before.case.status);
      assert.equal(after.events.length, before.events.length);
      assert.equal(after.submissions.length, 2);
    });
    await r.step('corrected claim form clears the mismatch; intake checks complete is then allowed; claimant is read-only', async () => {
      assert.equal((await api('POST', '/api/documents/sample', 'reviewer', { sampleId: 'S-CLAIM-FIX' })).status, 200);
      await api('POST', '/api/links/accept-suggested', 'reviewer', {});
      assert.equal((await api('POST', '/api/transition', 'reviewer', { to: 'intake_complete' })).status, 200);
      const st = await state('claimant');
      assert.equal(st.case.status, 'intake_complete');
      assert.equal(st.transitions.length, 0);
      assert.equal((await api('POST', '/api/documents/sample', 'claimant', { sampleId: 'S-LAB' })).status, 409);
      const j = JSON.parse((await api('GET', '/api/report?format=json', 'reviewer')).text);
      assert.equal(j.outcome.complete, true);
      assert.match(j.notice, /not a coverage decision/);
    });
    await r.step('dashboard and queue are labelled DEMO / synthetic', async () => {
      assert.equal((await api('GET', '/api/dashboard', 'reviewer')).json.synthetic, true);
      assert.equal((await api('GET', '/api/queue', 'reviewer')).json.demoData, true);
    });
    await r.step('reset restores the original fixture', async () => {
      assert.equal((await api('POST', '/api/reset', 'claimant', {})).status, 200);
      const st = await state();
      assert.equal(st.case.status, 'preparing');
      assert.equal(st.submissions.length, 0);
      assert.equal(st.documents.length, 7);
      assert.ok(open(st, 'REQ_MISSING') && open(st, 'FIELD_MISMATCH'));
    });
    await r.step('server log contains no document text or proof content', async () => {
      const log = srv.logs.join('');
      assert.doesNotMatch(log, /Grand Total|Aarav|SYNTHETIC RECEIPT|dataBase64/);
      assert.doesNotMatch(log, /\[stderr\]/);
    });
  } finally {
    await srv.stop();
    srv.cleanup();
  }
  process.exit(r.done());
})().catch((e) => { console.error(e); process.exit(1); });
