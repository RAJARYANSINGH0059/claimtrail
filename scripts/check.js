'use strict';
/**
 * Static quality gate ("build" for this zero-dependency app: there is nothing to bundle).
 * Verifies syntax, packaging, offline/no-network source, safe DOM use, honest wording, fixture determinism.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const { reporter } = require('./lib');
const r = reporter('check');
const walk = (d, ext) => fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith(ext)).map((f) => path.join(d, f));
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

(async () => {
  await r.step('Node version is supported (>=20)', () => { if (Number(process.versions.node.split('.')[0]) < 20) throw new Error(process.version); });

  await r.step('server-side JS parses (src, scripts, test)', () => {
    for (const f of [...walk('src', '.js'), ...walk('scripts', '.js'), ...walk('test', '.js')]) {
      const out = spawnSync(process.execPath, ['--check', path.join(root, f)], { encoding: 'utf8' });
      if (out.status !== 0) throw new Error(`${f}: ${out.stderr}`);
    }
  });
  await r.step('browser ES modules parse (public)', () => {
    for (const f of walk('public', '.js')) {
      const out = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: read(f), encoding: 'utf8' });
      if (out.status !== 0) throw new Error(`${f}: ${out.stderr}`);
    }
  });
  await r.step('index.html references only local assets that exist', () => {
    const html = read('public/index.html');
    for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const u = m[1];
      if (u.startsWith('#') || u.startsWith('data:')) continue;
      if (/^[a-z]+:\/\//i.test(u)) throw new Error(`external reference: ${u}`);
      if (!fs.existsSync(path.join(root, 'public', u.replace(/^\//, '')))) throw new Error(`missing asset: ${u}`);
    }
  });
  await r.step('no external URLs, CDNs or remote fonts in the UI', () => {
    for (const f of [...walk('public', '.js'), ...walk('public', '.css'), 'public/index.html']) {
      const hit = /https?:\/\/(?!localhost|127\.0\.0\.1)/i.exec(read(f));
      if (hit) throw new Error(`${f} contains ${hit[0]}`);
    }
  });
  await r.step('source makes no outbound network calls (only server.js may use node:http, and only to listen)', () => {
    for (const f of walk('src', '.js')) {
      const s = read(f);
      const bad = /require\(['"]node:(https|net|dns|tls|dgram|child_process)['"]\)|\bfetch\(|XMLHttpRequest|require\(['"](axios|node-fetch|got)['"]\)/.exec(s);
      if (bad && !(f === path.join('src', 'ocr.js') && /child_process/.test(bad[0]))) throw new Error(`${f}: ${bad[0]}`);
      if (f !== path.join('src', 'server.js') && /require\(['"]node:http['"]\)/.test(s)) throw new Error(`${f} imports node:http`);
    }
  });
  await r.step('OCR adapter only spawns tesseract/pdftotext/pdftoppm, with no shell and no network tools', () => {
    const s = read(path.join('src', 'ocr.js'));
    const calls = [...s.matchAll(/\brun\('([^']+)'/g)].map((m) => m[1]);
    const bad = calls.filter((c) => !['tesseract', 'pdftotext', 'pdftoppm'].includes(c));
    if (!calls.length || bad.length) throw new Error('unexpected binaries: ' + (bad.join(', ') || 'none found'));
    if (/shell:\s*true|\bexec\(|execSync|\bspawn\(|\bfork\(/.test(s)) throw new Error('ocr.js must only use spawnSync with shell:false');
    if (!/shell:\s*false/.test(s)) throw new Error('ocr.js must set shell:false');
  });
  await r.step('browser code never uses innerHTML/eval/document.write (uploaded text cannot inject markup)', () => {
    for (const f of walk('public', '.js')) {
      const bad = /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|\beval\(|new Function\(|document\.write/.exec(read(f));
      if (bad) throw new Error(`${f}: ${bad[0]}`);
    }
  });
  await r.step('no secrets or API keys in the repo', () => {
    const files = [...walk('src', '.js'), ...walk('public', '.js'), ...walk('scripts', '.js'), 'package.json', 'README.md'].filter((f) => fs.existsSync(path.join(root, f)));
    for (const f of files) {
      const hit = /(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|api[_-]?key\s*[:=]\s*['"][^'"]{8,})/i.exec(read(f));
      if (hit) throw new Error(`${f}: ${hit[0].slice(0, 12)}…`);
    }
    if (fs.existsSync(path.join(root, '.env'))) throw new Error('.env present');
  });
  await r.step('UI wording never implies approval, payout, fraud findings, live integration or real impact', () => {
    const banned = /claim (?:is |was )?approved|approved claim|payout|settlement amount|fraud(?:ulent)? (?:detected|score|risk|alert)|likely fraud|live (?:insurer|paytm) integration|connected to paytm|powered by (?:gpt|claude|openai)|saves? (?:\$|₹|rs)|\d+% (?:faster|reduction|savings)/i;
    for (const f of [...walk('public', '.js'), 'public/index.html', 'src/drafts.js', 'src/exporters.js', 'src/fixtures.js', 'src/dashboard.js', 'src/lifecycle.js']) {
      const hit = banned.exec(read(f));
      if (hit) throw new Error(`${f}: "${hit[0]}"`);
    }
  });
  await r.step('required safety disclaimers are present in the UI shell and exports', () => {
    const html = read('public/index.html');
    for (const t of ['DEMO DATA', 'does not decide claims', 'future work']) if (!html.includes(t)) throw new Error(`index.html lacks "${t}"`);
    if (!/not a coverage decision/i.test(read('src/exporters.js'))) throw new Error('report lacks coverage disclaimer');
  });
  await r.step('fixtures are deterministic: two fresh stores with the same clock produce identical state', () => {
    const { Store } = require('../src/store');
    const mk = () => new Store({ now: () => new Date('2026-10-24T06:00:00.000Z') });
    const a = JSON.stringify(mk().snapshot('reviewer')), b = JSON.stringify(mk().snapshot('reviewer'));
    if (a !== b) throw new Error('snapshots differ');
  });
  await r.step('fixture data is fictional (names marked fictional/synthetic; no real-looking IDs)', () => {
    const s = read('src/fixtures.js');
    if (!/FICTIONAL/.test(s) || !/DEMO/.test(s)) throw new Error('fixture lacks fictional markers');
    if (/\b\d{4}\s?\d{4}\s?\d{4}\b/.test(s)) throw new Error('12-digit ID-like number in fixtures');
  });
  await r.step('deliverable docs exist', () => {
    for (const f of ['README.md', 'BUILD_STATUS.md', 'docs/PRODUCT_SPEC.md', 'docs/TEST_REPORT.md', 'docs/DEMO_SCRIPT.md', 'docs/PITCH_DECK.md']) {
      if (!fs.existsSync(path.join(root, f))) throw new Error(`missing ${f}`);
    }
  });
  process.exit(r.done());
})();
