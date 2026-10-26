'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadConfig, publicAiStatus, parseOrigins } = require('../src/config');
const { KEY } = require('./helpers-sarvam');

test('defaults: rules-only, local bind, port 3000, no key exposed, no warnings', () => {
  const c = loadConfig({});
  assert.deepEqual([c.ai.provider, c.ai.state, c.host, c.port, c.hosted, c.dataFile, c.sarvamApiKey], ['rules', 'rules_only', '127.0.0.1', 3000, false, null, null]);
  assert.deepEqual(c.warnings, []);
  assert.deepEqual(c.frontendOrigins, []);
});

test('hosted production binds 0.0.0.0 and honours PORT; HOST can still override', () => {
  assert.equal(loadConfig({ NODE_ENV: 'production', PORT: '10000' }).host, '0.0.0.0');
  assert.equal(loadConfig({ NODE_ENV: 'production', PORT: '10000' }).port, 10000);
  assert.equal(loadConfig({ RENDER: 'true' }).host, '0.0.0.0');
  assert.equal(loadConfig({ NODE_ENV: 'production', HOST: '127.0.0.1' }).host, '127.0.0.1');
  assert.equal(loadConfig({ NODE_ENV: 'development' }).host, '127.0.0.1');
});

test('invalid PORT falls back to 3000 with a warning', () => {
  for (const PORT of ['abc', '-1', '70000', '1.5']) {
    const c = loadConfig({ PORT });
    assert.equal(c.port, 3000, PORT);
    assert.ok(c.warnings.some((w) => /PORT/.test(w)), PORT);
  }
});

test('AI_PROVIDER: unknown values fail safe to rules with a visible warning; sarvam needs a real key', () => {
  for (const v of ['openai', 'sarvam-v2', 'true', '1', 'rules; drop table']) {
    const c = loadConfig({ AI_PROVIDER: v, SARVAM_API_KEY: KEY });
    assert.equal(c.ai.provider, 'rules', v);
    assert.equal(c.ai.state, 'invalid_config', v);
    assert.equal(c.sarvamApiKey, null, 'key is not even retained in invalid mode');
    assert.ok(c.warnings.length >= 1);
  }
  for (const key of [undefined, '', '   ', 'short']) {
    const c = loadConfig({ AI_PROVIDER: 'sarvam', SARVAM_API_KEY: key });
    assert.equal(c.ai.provider, 'rules');
    assert.equal(c.ai.state, 'sarvam_missing_key');
    assert.equal(c.sarvamApiKey, null);
  }
  const on = loadConfig({ AI_PROVIDER: ' Sarvam ', SARVAM_API_KEY: ` ${KEY} ` });
  assert.deepEqual([on.ai.provider, on.ai.state, on.sarvamApiKey], ['sarvam', 'sarvam_available', KEY]);
  assert.equal(loadConfig({ AI_PROVIDER: 'RULES', SARVAM_API_KEY: KEY }).sarvamApiKey, null, 'rules mode never holds the key');
});

test('a key present with AI_PROVIDER unset or rules stays unused (no accidental enabling)', () => {
  for (const env of [{ SARVAM_API_KEY: KEY }, { AI_PROVIDER: 'rules', SARVAM_API_KEY: KEY }, { AI_PROVIDER: '', SARVAM_API_KEY: KEY }]) {
    const c = loadConfig(env);
    assert.equal(c.ai.provider, 'rules');
    assert.equal(publicAiStatus(c).badge, 'rules_only');
  }
});

test('public status never contains the key or env values, and the badge is only "used" after real cloud documents exist', () => {
  const c = loadConfig({ AI_PROVIDER: 'sarvam', SARVAM_API_KEY: KEY, FRONTEND_ORIGINS: 'https://x.example.com', CLAIMTRAIL_DATA: '/var/data/secret-path.json' });
  for (const n of [0, 2]) {
    const s = JSON.stringify(publicAiStatus(c, { cloudDocuments: n }));
    assert.ok(!s.includes(KEY)); assert.ok(!s.includes('secret-path')); assert.ok(!s.includes('x.example.com'));
  }
  assert.equal(publicAiStatus(c, { cloudDocuments: 0 }).badge, 'sarvam_available');
  assert.equal(publicAiStatus(c, { cloudDocuments: 1 }).badge, 'sarvam_used');
  assert.equal(publicAiStatus(loadConfig({}), { cloudDocuments: 0 }).badge, 'rules_only');
  assert.match(publicAiStatus(c).cloudNotice, /external AI service/);
});

test('FRONTEND_ORIGINS: exact origins only; wildcard, paths, bare hosts and junk are ignored with warnings', () => {
  const w = [];
  const o = parseOrigins('https://a.vercel.app, https://a.vercel.app/ , http://localhost:5173, *, https://b.vercel.app/app, a.vercel.app, null, javascript:alert(1), ftp://x.example.com, https://*.vercel.app', w);
  assert.deepEqual(o, ['https://a.vercel.app', 'http://localhost:5173']);
  assert.ok(w.length >= 6);
  assert.deepEqual(parseOrigins('', []), []);
  assert.deepEqual(parseOrigins(undefined, []), []);
});

test('CLAIMTRAIL_DATA becomes an absolute path', () => {
  assert.equal(loadConfig({ CLAIMTRAIL_DATA: '/var/data/state.json' }).dataFile, '/var/data/state.json');
  assert.ok(path.isAbsolute(loadConfig({ CLAIMTRAIL_DATA: 'rel/state.json' }).dataFile));
});
