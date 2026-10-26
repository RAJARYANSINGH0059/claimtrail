'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { createServer } = require('../src/server');
const { loadConfig } = require('../src/config');
const { mkStore } = require('./helpers');
const { buildDist, verifyDist } = require('../scripts/build-dist');
const { startServer, startStatic, freePort } = require('../scripts/lib');

const ROOT = path.join(__dirname, '..');
const APP = 'https://claimtrail.vercel.app';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

async function withApi(env, fn) {
  const server = createServer(mkStore(), { quiet: true, config: loadConfig(env) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { await new Promise((r) => server.close(r)); }
}
const call = (base, p, { method = 'GET', headers = {} } = {}) => fetch(base + p, { method, headers, redirect: 'manual' });

test('CORS: only exact configured origins get allow-origin; never a wildcard, never credentials', () => withApi({ FRONTEND_ORIGINS: `${APP}, https://preview-1.vercel.app` }, async (b) => {
  for (const origin of [APP, 'https://preview-1.vercel.app']) {
    const r = await call(b, '/api/state', { headers: { Origin: origin, 'X-Role': 'claimant' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), origin);
    assert.equal(r.headers.get('access-control-allow-credentials'), null);
    assert.match(r.headers.get('vary'), /Origin/);
    assert.equal(r.headers.get('access-control-expose-headers'), 'Content-Disposition');
  }
  for (const origin of ['https://evil.example', APP + '.evil.example', 'http://claimtrail.vercel.app', APP + ':8443', 'null', 'https://claimtrail.vercel.app/']) {
    const r = await call(b, '/api/state', { headers: { Origin: origin, 'X-Role': 'claimant' } });
    assert.equal(r.headers.get('access-control-allow-origin'), null, `origin ${origin}`);
    assert.equal(r.headers.get('access-control-allow-credentials'), null);
  }
  const none = await call(b, '/api/state', { headers: { 'X-Role': 'claimant' } });
  assert.equal(none.headers.get('access-control-allow-origin'), null);
}));

test('CORS preflight: allowed origin gets the exact methods and headers; disallowed origin is refused with no permissive headers', () => withApi({ FRONTEND_ORIGINS: APP }, async (b) => {
  const ok = await call(b, '/api/documents', { method: 'OPTIONS', headers: { Origin: APP, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-role' } });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), APP);
  assert.equal(ok.headers.get('access-control-allow-methods'), 'GET, POST, PATCH, DELETE, OPTIONS');
  assert.equal(ok.headers.get('access-control-allow-headers'), 'Content-Type, X-Role');
  assert.equal(ok.headers.get('access-control-allow-credentials'), null);
  const bad = await call(b, '/api/documents', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
  assert.equal(bad.headers.get('access-control-allow-methods'), null);
}));

test('with no FRONTEND_ORIGINS configured, no origin is ever allowed (same-origin only)', () => withApi({}, async (b) => {
  const r = await call(b, '/api/health/live', { headers: { Origin: APP } });
  assert.equal(r.headers.get('access-control-allow-origin'), null);
  const p = await call(b, '/api/state', { method: 'OPTIONS', headers: { Origin: APP, 'Access-Control-Request-Method': 'GET' } });
  assert.equal(p.status, 403);
}));

test('health: live and ready are anonymous, 2xx, tiny, and reveal nothing about the environment or state', () => withApi({ AI_PROVIDER: 'sarvam', SARVAM_API_KEY: 'sk_test_SECRET_1234567890' }, async (b) => {
  for (const p of ['/api/health/live', '/api/health/ready', '/api/health']) {
    const r = await call(b, p);
    const t = await r.text();
    assert.equal(r.status, 200, p);
    assert.ok(t.length < 60, `${p}: ${t}`);
    assert.doesNotMatch(t, /SECRET|sarvam|KEY|\/tmp|\/home|Aarav|CLM-/i);
  }
  assert.equal((await call(b, '/api/state')).status, 401, 'everything else still needs a role');
}));

test('readiness reports 503 (without details) when the configured data directory is not writable', () => withApi({ CLAIMTRAIL_DATA: '/nonexistent-dir-xyz/state.json' }, async (b) => {
  const r = await call(b, '/api/health/ready');
  assert.equal(r.status, 503);
  const t = await r.text();
  assert.doesNotMatch(t, /nonexistent|state\.json/);
  assert.equal((await call(b, '/api/health/live')).status, 200, 'liveness is independent of storage');
}));

test('a real process in production mode honours PORT and binds 0.0.0.0; locally it binds 127.0.0.1', async () => {
  const run = async (env, expectHost) => {
    const port = await freePort();
    const dir = tmp('ct-bind-');
    const logs = [];
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], { env: { PATH: process.env.PATH, PORT: String(port), CLAIMTRAIL_DATA: path.join(dir, 's.json'), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => logs.push(String(d))); child.stderr.on('data', (d) => logs.push(String(d)));
    try {
      let up = false;
      for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${port}/api/health/ready`)).ok; } catch { await new Promise((r) => setTimeout(r, 100)); } }
      assert.ok(up, 'server did not start: ' + logs.join(''));
      assert.match(logs.join(''), new RegExp(`listening on ${expectHost.replace(/\./g, '\\.')}:${port}`));
      assert.doesNotMatch(logs.join(''), /SECRET/);
    } finally { child.kill('SIGTERM'); await new Promise((r) => child.once('exit', r)); fs.rmSync(dir, { recursive: true, force: true }); }
  };
  await run({ NODE_ENV: 'production' }, '0.0.0.0');
  await run({ RENDER: 'true' }, '0.0.0.0');
  await run({}, '127.0.0.1');
  await run({ NODE_ENV: 'production', HOST: '127.0.0.1' }, '127.0.0.1');
});

test('startup warnings never print the key; invalid AI_PROVIDER fails safe', async () => {
  const port = await freePort(); const dir = tmp('ct-warn-');
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], { env: { PATH: process.env.PATH, PORT: String(port), AI_PROVIDER: 'gpt-evil', SARVAM_API_KEY: 'sk_test_SECRET_1234567890', CLAIMTRAIL_DATA: path.join(dir, 's.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = []; child.stdout.on('data', (d) => logs.push(String(d))); child.stderr.on('data', (d) => logs.push(String(d)));
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/health/live`)).ok) break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const s = await (await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { 'X-Role': 'claimant' } })).json();
    assert.equal(s.meta.aiProvider.badge, 'rules_only');
    assert.equal(s.meta.aiProvider.features.documentAnalysis, false);
    assert.match(logs.join(''), /Unknown AI_PROVIDER/);
    assert.doesNotMatch(logs.join('') + JSON.stringify(s), /SECRET/);
  } finally { child.kill('SIGTERM'); await new Promise((r) => child.once('exit', r)); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('api-base: origin-only config; apiUrl joins safely and refuses anything that is not a plain /api/ route', async () => {
  const { normalizeApiBase, apiUrl, configuredBase } = await import(pathToFileURL(path.join(ROOT, 'public', 'api-base.mjs')).href);
  assert.equal(normalizeApiBase(''), '');
  assert.equal(normalizeApiBase(undefined), '');
  assert.equal(normalizeApiBase('https://api.example.com/'), 'https://api.example.com');
  assert.equal(normalizeApiBase(' https://api.example.com:8443 '), 'https://api.example.com:8443');
  for (const bad of ['https://api.example.com/v1', 'https://u:p@api.example.com', 'https://api.example.com?x=1', 'https://api.example.com/#x', 'javascript:alert(1)', 'ftp://x.com', 'api.example.com', 42]) assert.throws(() => normalizeApiBase(bad), Error, String(bad));
  assert.equal(apiUrl('/api/state', ''), '/api/state');
  assert.equal(apiUrl('/api/export/manifest?format=json', 'https://api.example.com'), 'https://api.example.com/api/export/manifest?format=json');
  for (const bad of ['//evil.example/api/x', 'https://evil.example/api/x', '/api/../etc', '/apix', 'api/state', '/api//x', '/api/\\evil', '']) assert.throws(() => apiUrl(bad, 'https://api.example.com'), Error, String(bad));
  assert.equal(configuredBase({ CLAIMTRAIL_CONFIG: { apiBaseUrl: 'https://a.example' } }), 'https://a.example');
  assert.equal(configuredBase({}), '');
  assert.throws(() => configuredBase({ CLAIMTRAIL_CONFIG: { apiBaseUrl: 'https://a.example/x' } }));
});

test('every browser fetch goes through apiUrl: no raw fetch(path) anywhere in public/', () => {
  for (const f of fs.readdirSync(path.join(ROOT, 'public')).filter((n) => /\.(m?js)$/.test(n))) {
    const src = fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');
    for (const m of src.matchAll(/\bfetch\(([^)]*)\)/g)) assert.match(m[1], /^url\(/, `${f}: ${m[0]}`);
  }
});

test('build:dist: complete assets, generated escaped config, exact CSP connect-src, tracked config untouched, no secrets', async () => {
  const before = fs.readFileSync(path.join(ROOT, 'public', 'config.js'), 'utf8');
  const out = tmp('ct-dist-');
  try {
    const r = await buildDist({ apiBase: 'https://claimtrail-api.onrender.com/', outDir: out, env: { SARVAM_API_KEY: 'sk_test_SECRET_1234567890' } });
    assert.equal(r.apiBase, 'https://claimtrail-api.onrender.com');
    const cfg = fs.readFileSync(path.join(out, 'config.js'), 'utf8');
    assert.match(cfg, /Object\.freeze\(\{"apiBaseUrl":"https:\/\/claimtrail-api\.onrender\.com"\}\)/);
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.match(html, /connect-src 'self' https:\/\/claimtrail-api\.onrender\.com;/);
    assert.doesNotMatch(html, /connect-src[^;]*\*/);
    for (const f of ['app.js', 'cloud.js', 'api-base.mjs', 'styles.css', 'components.js', 'ui.js', 'claimant.js', 'intake.js', 'config.js']) assert.ok(fs.existsSync(path.join(out, f)), f);
    assert.equal(fs.readFileSync(path.join(ROOT, 'public', 'config.js'), 'utf8'), before, 'tracked config.js must not change');
    const all = fs.readdirSync(out).map((f) => fs.readFileSync(path.join(out, f), 'utf8')).join('\n');
    assert.doesNotMatch(all, /SECRET|api-subscription-key|SARVAM_API_KEY/);
    const same = await buildDist({ apiBase: '', outDir: out });
    assert.match(fs.readFileSync(path.join(out, 'config.js'), 'utf8'), /"apiBaseUrl":""/);
    assert.match(fs.readFileSync(path.join(out, 'index.html'), 'utf8'), /connect-src 'self'; object-src/);
    assert.equal(same.apiBase, '');
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('build:dist fails loudly on a bad base, a missing asset, a missing module, or a leaked secret', async () => {
  const out = tmp('ct-dist-');
  const src = tmp('ct-src-'); fs.cpSync(path.join(ROOT, 'public'), src, { recursive: true });
  try {
    for (const bad of ['https://a.example/path', 'https://u:p@a.example', 'javascript:alert(1)']) await assert.rejects(() => buildDist({ apiBase: bad, outDir: out }), bad);
    await assert.rejects(() => buildDist({ apiBase: '', outDir: ROOT }), /Refusing/);
    await assert.rejects(() => buildDist({ apiBase: '', outDir: path.join(ROOT, 'public') }), /Refusing/);
    fs.rmSync(path.join(src, 'styles.css'));
    await assert.rejects(() => buildDist({ apiBase: '', srcDir: src, outDir: out }), /missing file: \/styles\.css/);
    fs.cpSync(path.join(ROOT, 'public', 'styles.css'), path.join(src, 'styles.css'));
    fs.rmSync(path.join(src, 'cloud.js'));
    await assert.rejects(() => buildDist({ apiBase: '', srcDir: src, outDir: out }), /missing module: \.\/cloud\.js/);
    fs.cpSync(path.join(ROOT, 'public', 'cloud.js'), path.join(src, 'cloud.js'));
    fs.appendFileSync(path.join(src, 'app.js'), '\n// sk_test_SECRET_1234567890\n');
    await assert.rejects(() => buildDist({ apiBase: '', srcDir: src, outDir: out, env: { SARVAM_API_KEY: 'sk_test_SECRET_1234567890' } }), /contains the SARVAM_API_KEY value/);
  } finally { fs.rmSync(out, { recursive: true, force: true }); fs.rmSync(src, { recursive: true, force: true }); }
});

test('CLI: `node scripts/build-dist.js` exits non-zero on an invalid CLAIMTRAIL_API_BASE_URL and zero on a valid one', () => {
  const run = (v) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-dist.js')], { env: { PATH: process.env.PATH, CLAIMTRAIL_API_BASE_URL: v }, encoding: 'utf8' });
  assert.notEqual(run('https://x.example/nope').status, 0);
  const ok = run('https://x.example');
  assert.equal(ok.status, 0, ok.stderr);
  fs.rmSync(path.join(ROOT, 'dist'), { recursive: true, force: true });
});

test('exports and status tell the truth once a Sarvam-read document is in the packet', () => {
  const store = mkStore();
  const rules = JSON.parse(store.manifest('claimant', 'json').body);
  assert.equal(rules.analysisMode, 'deterministic rules (no AI model used)');
  assert.equal(store.snapshot('claimant').meta.ai.cloudDocuments, 0);
  store.addCloudDocument('claimant', {
    name: 'scan.png', mime: 'image/png', size: 100, sha256: 'a'.repeat(64), jobId: 'job_1', language: 'en-IN', partial: false,
    pages: [{ n: 1, text: 'Pharmacy cash memo\nTotal amount: 1,000', ocr: { method: 'sarvam-document-ai', status: 'verify' } }],
  });
  const m = JSON.parse(store.manifest('claimant', 'json').body);
  assert.match(m.analysisMode, /Sarvam Document AI \(an external cloud service/);
  assert.doesNotMatch(m.analysisMode, /no AI model used/);
  const doc = m.documents.find((d) => d.name === 'scan.png');
  assert.equal(doc.cloudExtraction.confidence, 'not supplied');
  const rep = JSON.parse(store.report('claimant' === 'x' ? 'reviewer' : 'reviewer', 'json').body);
  assert.match(rep.analysisMode, /Sarvam/);
  const snap = store.snapshot('claimant');
  assert.equal(snap.meta.ai.cloudDocuments, 1);
  assert.equal(snap.meta.ai.live, true);
  assert.match(snap.meta.ai.note, /external cloud service/);
  // machine-read evidence never confirms anything by itself
  assert.ok(snap.links.filter((l) => l.docId === snap.documents.find((d) => d.name === 'scan.png').id).every((l) => l.decision !== 'accepted'));
});

test('deployment-smoke: passes against a monolith and a split deployment, and FAILS when CORS is wrong or the key leaks', async () => {
  const run = (env) => new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'scripts', 'deployment-smoke.js')], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  assert.equal((await run({})).status, 2, 'unconfigured is NOT RUN, not a pass');
  const mono = await startServer();
  try {
    const r = await run({ APP_URL: mono.url, API_BASE_URL: mono.url });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally { await mono.stop(); mono.cleanup(); }

  const fePort = await freePort();
  const api = await startServer({ env: { FRONTEND_ORIGINS: `http://127.0.0.1:${fePort}` } });
  const dist = tmp('ct-dist-'); await buildDist({ apiBase: api.url, outDir: dist });
  const fe = await startStatic(dist, fePort);
  try {
    const ok = await run({ APP_URL: fe.url, API_BASE_URL: api.url });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /frontend origin is allowed exactly/);
    const wrong = await run({ APP_URL: 'http://127.0.0.1:1', API_BASE_URL: api.url });
    assert.equal(wrong.status, 1, 'a frontend the API does not allow must fail the smoke');
  } finally { await fe.stop(); await api.stop(); api.cleanup(); fs.rmSync(dist, { recursive: true, force: true }); }
});
