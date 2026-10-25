'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer } = require('../src/server');
const { mkStore, b64 } = require('./helpers');

async function withServer(fn) {
  const store = mkStore();
  const server = createServer(store, { quiet: true });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { role, body, raw, headers } = {}) => {
    const h = { ...(role ? { 'X-Role': role } : {}), ...(headers || {}) };
    let payload;
    if (raw !== undefined) payload = raw;
    else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    else if (method === 'POST' || method === 'PATCH') { h['Content-Type'] = 'application/json'; payload = '{}'; }
    const res = await fetch(base + path, { method, headers: h, body: payload });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, headers: res.headers, text, json };
  };
  try { await fn({ call, store, base }); } finally { await new Promise((r) => server.close(r)); }
}

test('health is open; every other API route needs a known role', () => withServer(async ({ call }) => {
  assert.equal((await call('GET', '/api/health')).status, 200);
  const none = await call('GET', '/api/state');
  assert.equal(none.status, 401);
  assert.equal(none.json.error.code, 'ROLE_REQUIRED');
  const bad = await call('GET', '/api/state', { role: 'admin' });
  assert.equal(bad.status, 403);
  const ok = await call('GET', '/api/state', { role: 'claimant' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.meta.demoData, true);
  assert.equal(ok.json.meta.ai.live, false);
}));

test('claimant and reviewer read the same case, evidence and findings', () => withServer(async ({ call }) => {
  const a = (await call('GET', '/api/state', { role: 'claimant' })).json;
  const b = (await call('GET', '/api/state', { role: 'reviewer' })).json;
  for (const k of ['case', 'requirements', 'documents', 'links', 'statuses', 'comparisons', 'findings', 'events']) assert.deepEqual(a[k], b[k], k);
  assert.notDeepEqual(a.can, b.can);
  assert.ok(a.can['document.add'] && !a.can['finding.resolve']);
}));

test('role-specific routes: claimant is refused the queue, dashboard, report and finding actions', () => withServer(async ({ call }) => {
  for (const p of ['/api/queue', '/api/dashboard', '/api/report?format=md']) {
    const r = await call('GET', p, { role: 'claimant' });
    assert.equal(r.status, 403, p);
    assert.equal(r.json.error.code, 'FORBIDDEN_ROLE');
  }
  assert.equal((await call('GET', '/api/queue', { role: 'reviewer' })).status, 200);
  assert.equal((await call('GET', '/api/dashboard', { role: 'reviewer' })).json.synthetic, true);
  const f = (await call('GET', '/api/state', { role: 'claimant' })).json.findings.find((x) => x.code === 'DUP_LIKELY');
  const r = await call('POST', '/api/findings/resolve', { role: 'claimant', body: { key: f.key, note: 'claimant override attempt' } });
  assert.equal(r.status, 403);
}));

test('Submitted is refused over HTTP without proof; the refusal lists reasons and nothing changes', () => withServer(async ({ call }) => {
  await call('POST', '/api/documents/sample', { role: 'claimant', body: { sampleId: 'S-LAB' } });
  assert.equal((await call('POST', '/api/transition', { role: 'claimant', body: { to: 'ready_for_review' } })).status, 200);
  const r = await call('POST', '/api/transition', { role: 'claimant', body: { to: 'submitted' } });
  assert.equal(r.status, 422);
  assert.equal(r.json.error.code, 'PROOF_REQUIRED');
  assert.ok(r.json.error.details.reasons.length >= 1);
  const st = (await call('GET', '/api/state', { role: 'claimant' })).json;
  assert.equal(st.case.status, 'ready_for_review');
  assert.equal(st.submissions.length, 0);
  const ok = await call('POST', '/api/transition', { role: 'claimant', body: { to: 'submitted', proof: { reference: 'SUB-HTTP-0001', fileName: 'r.txt', dataBase64: b64('SYNTHETIC') } } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.to, 'submitted');
}));

test('upload errors are actionable: bad type, bad base64, too large, wrong content type, bad JSON, oversized body', () => withServer(async ({ call }) => {
  const up = (body) => call('POST', '/api/documents', { role: 'claimant', body });
  const t = await up({ name: 'a.exe', dataBase64: b64('x') });
  assert.equal(t.status, 415);
  assert.match(t.json.error.message, /Allowed:/);
  assert.equal((await up({ name: 'a.txt', dataBase64: '***' })).status, 422);
  assert.equal((await up({ name: 'a.txt', dataBase64: Buffer.alloc(1_200_000, 97).toString('base64') })).status, 413);
  assert.equal((await call('POST', '/api/documents', { role: 'claimant', raw: 'name=a', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await call('POST', '/api/documents', { role: 'claimant', raw: '{oops', headers: { 'Content-Type': 'application/json' } })).status, 400);
  const big = await call('POST', '/api/documents', { role: 'claimant', raw: JSON.stringify({ name: 'a.txt', dataBase64: 'A'.repeat(3_200_000) }), headers: { 'Content-Type': 'application/json' } }).catch((e) => ({ status: 'closed', e }));
  assert.ok(big.status === 413 || big.status === 'closed');
  const ok = await up({ name: 'extra_note.txt', dataBase64: b64('A short fictional note for the packet.') });
  assert.equal(ok.status, 200);
}));

test('exports download with attachment headers and carry the not-a-submission notice', () => withServer(async ({ call, store }) => {
  const m = await call('GET', '/api/export/manifest?format=json', { role: 'claimant' });
  assert.equal(m.status, 200);
  assert.match(m.headers.get('content-disposition'), /attachment; filename="claimtrail-packet-manifest\.json"/);
  assert.match(JSON.parse(m.text).notice, /NOT a submission/);
  const c = await call('GET', '/api/export/missing', { role: 'claimant' });
  assert.match(c.text, /Diagnostic/);
  assert.equal((await call('GET', '/api/export/manifest?format=xml', { role: 'claimant' })).status, 422);
  assert.equal(store.status, 'preparing');
  const rep = await call('GET', '/api/report?format=md', { role: 'reviewer' });
  assert.match(rep.text, /not a coverage decision/i);
}));

test('static UI is served with a strict CSP; path traversal and unknown routes are refused', () => withServer(async ({ call, base }) => {
  const idx = await call('GET', '/');
  assert.equal(idx.status, 200);
  assert.match(idx.text, /DEMO DATA/);
  assert.match(idx.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(idx.headers.get('x-content-type-options'), 'nosniff');
  assert.match(idx.text, /not a login|demo switch/i);
  const raw = await new Promise((resolve) => {
    const u = new URL(base);
    http.get({ host: u.hostname, port: u.port, path: '/..%2f..%2fpackage.json' }, (res) => { res.resume(); resolve(res.statusCode); });
  });
  assert.ok(raw === 403 || raw === 404, `traversal got ${raw}`);
  assert.equal((await call('GET', '/api/nope', { role: 'claimant' })).status, 404);
  assert.equal((await call('DELETE', '/api/state', { role: 'claimant' })).status, 405);
  assert.equal((await call('GET', '/missing.js')).status, 404);
  for (const f of ['/app.js', '/components.js', '/styles.css', '/ui.js']) assert.equal((await call('GET', f)).status, 200, f);
}));

test('reset over HTTP restores the fixture after changes', () => withServer(async ({ call }) => {
  const before = (await call('GET', '/api/state', { role: 'claimant' })).json;
  await call('POST', '/api/documents/sample', { role: 'claimant', body: { sampleId: 'S-LAB' } });
  await call('POST', '/api/drafts', { role: 'claimant', body: { kind: 'follow_up' } });
  const mid = (await call('GET', '/api/state', { role: 'claimant' })).json;
  assert.notEqual(mid.documents.length, before.documents.length);
  assert.equal((await call('POST', '/api/reset', { role: 'reviewer' })).status, 200);
  const after = (await call('GET', '/api/state', { role: 'claimant' })).json;
  assert.deepEqual(after.documents.map((d) => [d.id, d.name, d.sha256]), before.documents.map((d) => [d.id, d.name, d.sha256]));
  assert.deepEqual(after.findings.map((f) => f.key), before.findings.map((f) => f.key));
  assert.equal(after.drafts.length, 0);
  assert.equal(after.case.status, 'preparing');
}));

test('page viewer returns source text and rejects unknown pages', () => withServer(async ({ call }) => {
  const st = (await call('GET', '/api/state', { role: 'reviewer' })).json;
  const bill = st.documents.find((d) => d.name === 'hospital_final_bill.txt');
  const p2 = await call('GET', `/api/documents/${bill.id}/pages/2`, { role: 'reviewer' });
  assert.match(p2.json.text, /Grand Total/);
  assert.equal((await call('GET', `/api/documents/${bill.id}/pages/9`, { role: 'reviewer' })).status, 404);
  assert.equal((await call('GET', '/api/documents/D-999/pages/1', { role: 'reviewer' })).status, 404);
  const scan = st.documents.find((d) => d.name === 'pharmacy_bill_scan.png');
  const sp = await call('GET', `/api/documents/${scan.id}/pages/1`, { role: 'reviewer' });
  assert.equal(sp.json.readable, false);
  assert.equal(sp.json.isImage, true);
}));
