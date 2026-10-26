'use strict';
/**
 * Non-mutating deployment check (GET and OPTIONS only; never POSTs, resets or edits anything).
 *   APP_URL=https://claimtrail.vercel.app API_BASE_URL=https://claimtrail-api.onrender.com node scripts/deployment-smoke.js
 * Either variable may be omitted (monolith: set both to the same URL). Exit 2 = NOT RUN, 1 = failure, 0 = pass.
 */
const assert = require('node:assert/strict');
const { reporter } = require('./lib');
const clean = (u) => (u ? new URL(u).origin : null);
const APP = clean(process.env.APP_URL), API = clean(process.env.API_BASE_URL);
if (!APP && !API) { console.log('deployment-smoke: NOT RUN (set APP_URL and/or API_BASE_URL).'); process.exit(2); }
const r = reporter('deployment-smoke');
const get = async (url, opts = {}) => { const res = await fetch(url, { redirect: 'manual', ...opts }); return { res, text: await res.text() }; };

(async () => {
  if (API) {
    await r.step('API liveness and readiness answer 2xx with a tiny body and no environment details', async () => {
      for (const p of ['/api/health/live', '/api/health/ready']) {
        const { res, text } = await get(API + p);
        assert.equal(res.status, 200, `${p} -> ${res.status}`);
        assert.ok(text.length < 100, 'health body should be tiny');
        assert.doesNotMatch(text, /SARVAM|KEY|process|env|path|\/var|\/home/i);
      }
    });
    await r.step('read-only state call works, is labelled demo data, and exposes no secret', async () => {
      const { res, text } = await get(API + '/api/state', { headers: { 'X-Role': 'reviewer' } });
      assert.equal(res.status, 200);
      const j = JSON.parse(text);
      assert.equal(j.meta.demoData, true);
      assert.doesNotMatch(text, /api-subscription-key|SARVAM_API_KEY|sk[-_][A-Za-z0-9_-]{16,}/);
      console.log(`        AI badge: ${j.meta.aiProvider ? j.meta.aiProvider.badgeLabel : 'n/a'}`);
    });
    await r.step('CORS: a random origin gets no allow-origin header', async () => {
      const { res } = await get(API + '/api/state', { method: 'OPTIONS', headers: { Origin: 'https://random-origin.example', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-role' } });
      assert.equal(res.headers.get('access-control-allow-origin'), null);
    });
    if (APP && APP !== API) await r.step('CORS: the frontend origin is allowed exactly (no wildcard, no credentials)', async () => {
      const { res } = await get(API + '/api/state', { method: 'OPTIONS', headers: { Origin: APP, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-role' } });
      assert.equal(res.headers.get('access-control-allow-origin'), APP);
      assert.equal(res.headers.get('access-control-allow-credentials'), null);
    });
  }
  if (APP) {
    await r.step('app serves the shell with the DEMO DATA banner and its config', async () => {
      const { res, text } = await get(APP + '/');
      assert.equal(res.status, 200);
      assert.match(text, /DEMO DATA/);
      const cfg = await get(APP + '/config.js');
      assert.equal(cfg.res.status, 200);
      if (API && APP !== API) assert.ok(cfg.text.includes(API), 'config.js should point at API_BASE_URL');
      assert.doesNotMatch(cfg.text, /SARVAM|api-subscription-key/i);
      for (const m of text.matchAll(/(?:src|href)="(\/[^"#?]+)"/g)) assert.equal((await get(APP + m[1])).res.status, 200, m[1]);
    });
  }
  process.exit(r.done());
})().catch((e) => { console.error(e); process.exit(1); });
