'use strict';
/**
 * ClaimTrail local server (zero dependencies). JSON API + static UI.
 * Roles are a DEMO switch sent in the X-Role header. There is no real authentication, session,
 * tenant isolation or rate limiting: those are future work. Binds to 127.0.0.1 by default.
 * Mutating requests need a custom header + JSON content type, and no CORS headers are sent, so a
 * foreign web page cannot drive the API from a browser.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Store, AppError } = require('./store');
const life = require('./lifecycle');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY = 3_000_000;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}
const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
const sendError = (res, e) => {
  if (e instanceof AppError) return sendJson(res, e.status, { error: { code: e.code, message: e.message, details: e.details } });
  console.error('Unexpected error:', e && e.message);
  return sendJson(res, 500, { error: { code: 'INTERNAL', message: 'Unexpected server error. The demo state was not changed by this request.' } });
};

function readJson(req) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '');
    if (!/^application\/json\b/i.test(type)) return reject(new AppError(415, 'JSON_REQUIRED', 'Send the body as application/json.'));
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new AppError(413, 'BODY_TOO_LARGE', 'The request is too large for the demo.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
        resolve(v);
      } catch { reject(new AppError(400, 'BAD_JSON', 'The request body is not valid JSON.')); }
    });
    req.on('error', () => reject(new AppError(400, 'BAD_REQUEST', 'The request could not be read.')));
  });
}

function download(res, out, base) {
  send(res, 200, out.body, { 'Content-Type': out.type, 'Content-Disposition': `attachment; filename="${base}.${out.ext}"` });
}

function buildRoutes(store) {
  const R = [];
  const add = (method, pattern, handler) => R.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler });
  const fmt = (q, allowed, dflt) => { const f = q.get('format') || dflt; if (!allowed.includes(f)) throw new AppError(422, 'FORMAT_INVALID', `format must be one of ${allowed.join(', ')}.`); return f; };

  add('GET', '/api/health', () => ({ ok: true, demoData: true }));
  add('GET', '/api/state', ({ role }) => store.snapshot(role));
  add('POST', '/api/reset', ({ role }) => { store._check(role, 'demo.reset'); store.reset(); return store.snapshot(role); });
  add('GET', '/api/samples', ({ role }) => { store._check(role, 'state.view'); return { samples: store.samples() }; });
  add('GET', '/api/queue', ({ role }) => store.queue(role));
  add('GET', '/api/dashboard', ({ role }) => store.dashboard(role));

  add('POST', '/api/requirements/extract', ({ role, body }) => store.extractCandidates(role, body.text));
  add('POST', '/api/requirements', ({ role, body }) => store.addRequirement(role, body));
  add('PATCH', '/api/requirements/:id', ({ role, body, params }) => store.updateRequirement(role, params.id, body));
  add('DELETE', '/api/requirements/:id', ({ role, params }) => store.removeRequirement(role, params.id));

  add('POST', '/api/documents', ({ role, body }) => store.uploadDocument(role, body));
  add('POST', '/api/documents/sample', ({ role, body }) => store.addSample(role, body));
  add('POST', '/api/documents/:id/withdraw', ({ role, body, params }) => store.withdrawDocument(role, params.id, body));
  add('POST', '/api/documents/:id/delivery', ({ role, body, params }) => store.setDelivery(role, params.id, body));
  add('GET', '/api/documents/:id/pages/:n', ({ role, params }) => { store._check(role, 'state.view'); return store.getPage(params.id, params.n); });

  add('POST', '/api/links/manual', ({ role, body }) => store.manualLink(role, body));
  add('POST', '/api/links/accept-suggested', ({ role }) => store.acceptSuggested(role));
  add('POST', '/api/links/:id/decision', ({ role, body, params }) => store.decideLink(role, params.id, body));

  add('POST', '/api/findings/resolve', ({ role, body }) => store.resolveFinding(role, body.key, body));
  add('POST', '/api/findings/reopen', ({ role, body }) => store.reopenFinding(role, body.key, body));
  add('POST', '/api/rerun', ({ role }) => store.rerun(role));

  add('POST', '/api/drafts', ({ role, body }) => store.createDraft(role, body.kind));
  add('POST', '/api/transition', ({ role, body }) => store.transition(role, body.to, { proof: body.proof }));

  add('GET', '/api/export/manifest', ({ role, query, res }) => download(res, store.manifest(role, fmt(query, ['json', 'md'], 'json')), 'claimtrail-packet-manifest'));
  add('GET', '/api/export/missing', ({ role, query, res }) => download(res, store.missingChecklist(role, fmt(query, ['md', 'json'], 'md')), 'claimtrail-missing-items'));
  add('GET', '/api/report', ({ role, query, res }) => download(res, store.report(role, fmt(query, ['md', 'json'], 'md')), 'claimtrail-intake-report'));
  return R;
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET is supported here.' } });
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return sendJson(res, 400, { error: { code: 'BAD_PATH', message: 'Bad path.' } }); }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: { code: 'FORBIDDEN_PATH', message: 'Not allowed.' } });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found.' } });
    send(res, 200, req.method === 'HEAD' ? '' : data, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  });
}

function createServer(store, { quiet = false } = {}) {
  const routes = buildRoutes(store);
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const t = req.method + ' ' + url.pathname;
    res.on('finish', () => { if (!quiet) console.log(`${t} ${res.statusCode}`); });
    try {
      if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
      const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!route) {
        const known = routes.some((r) => r.re.test(url.pathname));
        throw new AppError(known ? 405 : 404, known ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND', known ? 'Method not allowed.' : 'No such API route.');
      }
      let role = null;
      if (url.pathname !== '/api/health') {
        role = req.headers['x-role'];
        if (!role) throw new AppError(401, 'ROLE_REQUIRED', 'Send an X-Role header (claimant or reviewer). This demo has no real login.');
        if (!life.ROLES.includes(role)) throw new AppError(403, 'FORBIDDEN_ROLE', 'Unknown role.');
      }
      const params = route.re.exec(url.pathname).groups || {};
      const body = req.method === 'POST' || req.method === 'PATCH' ? await readJson(req) : {};
      const out = route.handler({ role, body, params, query: url.searchParams, res });
      if (!res.headersSent) sendJson(res, 200, out);
    } catch (e) {
      if (!res.headersSent) sendError(res, e);
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const file = process.env.CLAIMTRAIL_DATA || path.join(__dirname, '..', 'data', 'state.json');
  const store = new Store({ file });
  createServer(store).listen(port, host, () => {
    console.log(`ClaimTrail (DEMO DATA, local only) running at http://${host}:${port}`);
    console.log('Reset the demo from the UI footer or with: npm run reset');
  });
}

module.exports = { createServer, MAX_BODY };
