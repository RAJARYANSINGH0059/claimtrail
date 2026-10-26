'use strict';
/**
 * Browser smoke test (Playwright + Chromium). Playwright is NOT a dependency of this app; if it is not
 * installed this script says "NOT RUN" and exits 2 rather than pretending to pass.
 * Drives the full claimant -> reviewer -> correction -> resubmission -> report flow at desktop width,
 * then checks the narrow mobile layout, keyboard focus, labels, console errors and failed requests.
 */
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const os = require('node:os');
const { startServer, startStatic, reporter, freePort } = require('./lib');
const { buildDist } = require('./build-dist');

const SPLIT = process.argv.includes('--split'); // frontend from dist/ on ANOTHER origin, API cross-origin (Vercel + Render shape)

let pw;
try { pw = require('playwright'); } catch {
  if (process.env.CI) { console.error('ui-smoke: FAILED (playwright is not installed but CI=true: a missing browser test is a failure, not a pass).'); process.exit(1); }
  console.log('ui-smoke: NOT RUN (playwright is not installed). API smoke (npm run smoke) is the fallback.'); process.exit(2);
}

const SHOTS = SPLIT ? fs.mkdtempSync(path.join(os.tmpdir(), 'claimtrail-shots-')) : path.join(__dirname, '..', 'docs', 'screenshots'); // split runs never overwrite the documented screenshots
const r = reporter(SPLIT ? 'ui-smoke split (Chromium, dist/ on another origin)' : 'ui-smoke (Chromium)');

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  let fe = null, distDir = null, app;
  const srv = SPLIT ? await (async () => { const fp = await freePort(); fe = { port: fp }; return startServer({ env: { FRONTEND_ORIGINS: `http://127.0.0.1:${fp}` } }); })() : await startServer();
  if (SPLIT) {
    distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claimtrail-dist-'));
    await buildDist({ apiBase: srv.url, outDir: distDir });
    fe = await startStatic(distDir, fe.port);
    app = fe.url;
  } else app = srv.url;
  const browser = await pw.chromium.launch();
  const problems = [];
  const watch = (page, tag) => {
    // The app deliberately shows server refusals (422/409/403) in the UI; Chrome also logs them as "Failed to load resource". Those are expected, 5xx and everything else is not.
    page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !/Failed to load resource: the server responded with a status of 4\d\d/.test(m.text())) problems.push(`[${tag}] console.${m.type()}: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`[${tag}] pageerror: ${e.message}`));
    page.on('requestfailed', (q) => problems.push(`[${tag}] requestfailed: ${q.url()}`));
    page.on('response', (res) => { if (res.status() >= 500) problems.push(`[${tag}] HTTP ${res.status()} ${res.url()}`); });
  };
  const ctxD = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctxD.newPage();
  page.setDefaultTimeout(8000);
  watch(page, 'desktop');
  const fid = (id) => page.locator(`[data-fid="${id}"]`);
  const settle = async () => { await page.waitForFunction(() => document.getElementById('main').getAttribute('aria-busy') !== 'true'); await page.waitForTimeout(120); };
  const alertText = async () => (await page.locator('#alert').innerText()).replace(/\s+/g, ' ');
  const status = async () => (await page.locator('dl.meta-grid').first().innerText()).replace(/\s+/g, ' ');
  const dialog = () => page.locator('dialog[open]');
  const setRole = async (role) => { await fid(`role-${role}`).click(); await settle(); };

  try {
    await r.step('claimant workspace loads with DEMO DATA banner, requirements table and status', async () => {
      await page.goto(app + '/');
      await settle();
      assert.match(await page.locator('.banner').innerText(), /DEMO DATA/);
      assert.equal(await page.locator('h1').first().innerText(), 'Claim packet workspace');
      assert.ok((await page.locator('table[class*="stack"] tbody tr').count()) >= 7);
      assert.match(await status(), /Preparing/);
      const t = await page.locator('main').innerText();
      for (const s of ['Missing', 'Unreadable', 'Possible duplicate', 'Matched']) assert.ok(t.includes(s), s);
      await page.screenshot({ path: path.join(SHOTS, '01-claimant-desktop.png') });
    });
    await r.step('requirement source button opens the cited page with the excerpt highlighted', async () => {
      await page.getByRole('button', { name: /View source claim_form\.txt page 1/ }).first().click();
      await dialog().waitFor();
      assert.match(await dialog().innerText(), /Amount Claimed/);
      assert.ok((await dialog().locator('mark').count()) >= 1);
      await dialog().getByRole('button', { name: 'Close dialog' }).click();
    });
    await r.step('Mark ready is refused with a reason (missing lab report)', async () => {
      assert.equal(await fid('tr-ready_for_review').getAttribute('aria-disabled'), 'true');
      assert.match(await page.locator('.blocked').first().innerText(), /Diagnostic/);
      await fid('tr-ready_for_review').click({ force: true });
      await page.locator('#alert:not([hidden])').waitFor();
      assert.match(await alertText(), /Refused or failed.*Diagnostic/);
      assert.match(await status(), /Preparing/);
    });
    await r.step('sample lab report added; ready; submission refused without proof, then recorded with sample proof', async () => {
      await fid('smp-S-LAB').click(); await settle();
      await fid('tr-ready_for_review').click(); await settle();
      assert.match(await status(), /Ready for review/);
      await fid('tr-submitted').click();
      await dialog().waitFor();
      await dialog().getByRole('button', { name: 'Record', exact: true }).click();
      await dialog().locator('.form-error:not([hidden])').waitFor();
      assert.match(await dialog().locator('.form-error').innerText(), /reference|proof/i);
      assert.match(await status(), /Ready for review/);
      await dialog().getByRole('button', { name: /fictional sample reference/ }).click();
      await dialog().getByRole('button', { name: 'Record', exact: true }).click();
      await page.locator('dialog[open]').waitFor({ state: 'detached' });
      await settle();
      assert.match(await status(), /Submitted/);
      assert.ok(await page.getByText('SUB-DEMO-0001').first().isVisible());
    });
    await r.step('claimant exports are downloads and do not change status; follow-up draft is labelled not sent', async () => {
      const [dl] = await Promise.all([page.waitForEvent('download'), fid('exp-miss').click()]);
      assert.match(dl.suggestedFilename(), /missing-items/);
      const body = fs.readFileSync(await dl.path(), 'utf8');
      assert.match(body, /not a submission/i);
      await fid('draft-fu').click(); await settle();
      assert.match(await page.locator('article.draft').first().innerText(), /DRAFT — not sent/);
      assert.match(await status(), /Submitted/);
    });
    await r.step('reviewer role: navigation changes, queue shows DEMO DATA, claimant-only items disappear', async () => {
      await setRole('reviewer');
      assert.equal(await page.locator('h1').first().innerText().then((t) => t.replace(/\s+/g, ' ')), 'Intake queue DEMO DATA');
      const nav = await page.locator('nav[aria-label="Primary"]').innerText();
      assert.match(nav, /Queue/); assert.match(nav, /Dashboard/); assert.doesNotMatch(nav, /Workspace/);
      await page.screenshot({ path: path.join(SHOTS, '02-reviewer-queue-desktop.png') });
    });
    await r.step('open case, start intake review, read cited findings', async () => {
      await fid('open-case').click(); await settle();
      await fid('tr-intake_review').click(); await settle();
      assert.match(await status(), /Intake review/);
      const t = await page.locator('main').innerText();
      for (const c of ['FIELD_MISMATCH', 'DOC_PAGE_UNREADABLE', 'DUP_LIKELY']) assert.ok(t.includes(c), c);
      assert.match(t, /claim_form\.txt p\.1 vs hospital_final_bill\.txt p\.2|hospital_final_bill\.txt p\.2/);
      assert.match(await page.locator('.outcome').innerText(), /Not complete/);
    });
    await r.step('accept clean matches; resolve duplicate: empty note refused, note accepted; history kept', async () => {
      await fid('accept-all').click(); await settle();
      assert.ok((await page.getByText('accepted by reviewer').count()) >= 3);
      await page.locator('[data-fid^="res-DUP_LIKELY"]').click();
      await dialog().getByRole('button', { name: 'Resolve finding' }).click();
      await dialog().locator('.form-error:not([hidden])').waitFor();
      assert.match(await dialog().locator('.form-error').innerText(), /at least 5 characters/);
      await dialog().locator('textarea').fill('Patient copy of the same discharge summary; ignored.');
      await dialog().getByRole('button', { name: 'Resolve finding' }).click();
      await page.locator('dialog[open]').waitFor({ state: 'detached' }); await settle();
      assert.match(await page.locator('main').innerText(), /Reviewer override by reviewer/);
    });
    await r.step('intake complete is refused with reasons; request corrections moves to Action required', async () => {
      assert.equal(await fid('tr-intake_complete').getAttribute('aria-disabled'), 'true');
      assert.match(await page.locator('.blocked').last().innerText(), /FIELD_MISMATCH/);
      await fid('tr-action_required').click(); await settle();
      assert.match(await status(), /Action required/);
      assert.match(await page.locator('article.draft').first().innerText(), /not sent|did not send/i);
    });
    await r.step('claimant sees the correction request, adds corrections (re-upload diff visible) and records resubmission', async () => {
      await setRole('claimant');
      assert.match(await page.locator('.callout').innerText(), /Correction requested/);
      await fid('smp-S-PHARM').click(); await settle();
      await fid('smp-S-ID-FIX').click(); await settle();
      await page.locator('details.diff summary').first().click();
      assert.match(await page.locator('details.diff').first().innerText(), /readable pages: 0 → 1/);
      await fid('tr-resubmitted').click();
      await dialog().getByRole('button', { name: /fictional sample reference/ }).click();
      await dialog().getByRole('button', { name: 'Record', exact: true }).click();
      await page.locator('dialog[open]').waitFor({ state: 'detached' }); await settle();
      assert.match(await status(), /Resubmitted/);
    });
    await r.step('reviewer re-runs checks: mismatch stays open, completion refused with reasons, outcome says Not complete', async () => {
      await setRole('reviewer');
      await page.getByRole('link', { name: 'Case review' }).click(); await settle();
      await fid('rerun').click(); await settle();
      await fid('accept-all').click(); await settle();
      assert.match(await page.locator('.check-result').innerText(), /still open/);
      await fid('tr-intake_complete').click({ force: true });
      await page.locator('#alert:not([hidden])').waitFor();
      assert.match(await alertText(), /FIELD_MISMATCH/);
      assert.match(await page.locator('.outcome').innerText(), /Not complete[\s\S]*FIELD_MISMATCH/);
      await page.screenshot({ path: path.join(SHOTS, '03-reviewer-case-desktop.png') });
    });
    await r.step('corrected claim form clears the mismatch; intake checks complete (not a coverage decision)', async () => {
      await page.locator('#alert button').click();
      await fid('smp-S-CLAIM-FIX').click(); await settle();
      await fid('accept-all').click(); await settle();
      await fid('tr-intake_complete').click(); await settle();
      assert.match(await status(), /Intake checks complete/);
      assert.match(await page.locator('.outcome').innerText(), /not a coverage decision/i);
    });
    await r.step('report downloads and says intake complete is not a coverage decision', async () => {
      const [dl] = await Promise.all([page.waitForEvent('download'), fid('report-md').click()]);
      const body = fs.readFileSync(await dl.path(), 'utf8');
      assert.match(body, /Intake checks complete|passed/i);
      assert.match(body, /not a coverage decision/i);
    });
    await r.step('dashboard is labelled SYNTHETIC and shows four tiles', async () => {
      await page.getByRole('link', { name: 'Dashboard' }).click(); await settle();
      assert.match(await page.locator('h1').first().innerText(), /SYNTHETIC/);
      assert.equal(await page.locator('.tile').count(), 4);
      assert.match(await page.locator('main').innerText(), /not real performance/i);
      await page.screenshot({ path: path.join(SHOTS, '04-dashboard-desktop.png') });
    });
    await r.step('audit trail lists events in order', async () => {
      await page.getByRole('link', { name: 'Audit trail' }).click(); await settle();
      const n = await page.locator('table tbody tr').count();
      assert.ok(n > 30, `events: ${n}`);
    });
    await r.step('reset dialog restores the original fixture', async () => {
      await page.locator('#reset-btn').click();
      await dialog().getByRole('button', { name: 'Reset demo data' }).click();
      await page.locator('dialog[open]').waitFor({ state: 'detached' }); await settle();
      await setRole('claimant');
      assert.match(await status(), /Preparing/);
      assert.equal(await page.locator('main').innerText().then((t) => /Mark packet ready for review/.test(t)), true);
    });
    await r.step('keyboard: skip link is first, focus ring is visible, every control has an accessible name', async () => {
      await page.goto(app + '/'); await settle();
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.textContent.trim()), 'Skip to main content');
      for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');
      const outline = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return `${s.outlineStyle}|${s.outlineWidth}|${s.boxShadow}`; });
      assert.ok(!/^none\|/.test(outline) || !/none$/.test(outline), `focus indicator: ${outline}`);
      const unnamed = await page.evaluate(() => [...document.querySelectorAll('button, a[href], input, select, textarea')]
        .filter((el) => !el.closest('[hidden]'))
        .filter((el) => { const n = (el.getAttribute('aria-label') || el.textContent || '').trim(); const lab = el.labels && el.labels.length; return !n && !lab && !el.getAttribute('aria-labelledby') && el.type !== 'hidden'; })
        .map((el) => el.outerHTML.slice(0, 80)));
      assert.deepEqual(unnamed, []);
      assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    });
    await r.step('status is never colour-only: every chip has text', async () => {
      const empty = await page.evaluate(() => [...document.querySelectorAll('.chip')].filter((c) => !c.textContent.replace(/[^\p{L}]/gu, '').trim()).length);
      assert.equal(empty, 0);
    });
    await r.step('upload error states are actionable (unsupported type, empty file)', async () => {
      await page.goto(app + '/'); await settle();
      await page.locator('.adder input[type=file]').setInputFiles({ name: 'virus.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ') });
      await page.locator('.adder form button[type=submit]').click();
      await page.locator('.adder .form-error:not([hidden])').waitFor();
      assert.match(await page.locator('.adder .form-error').innerText(), /Unsupported file type.*Allowed/);
      await page.locator('.adder input[type=file]').setInputFiles({ name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) });
      await page.locator('.adder form button[type=submit]').click();
      await page.waitForFunction(() => /empty/i.test(document.querySelector('.adder .form-error').textContent));
      assert.match(await page.locator('.adder .form-error').innerText(), /empty/i);
      await page.locator('.adder input[type=file]').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('<img src=x onerror=alert(1)> A fictional note for the packet.') });
      await page.locator('.adder form button[type=submit]').click(); await settle();
      assert.ok(await page.getByText('note.txt').first().isVisible());
      assert.equal(await page.locator('img[src="x"]').count(), 0, 'uploaded text is not rendered as markup');
    });
    await r.step('real OCR in the browser: clean scan is read and labelled; degraded scan is rejected with a reason', async () => {
      const ocrLib = require('../src/ocr'); const nodeFs = require('node:fs'); const nodePath = require('node:path');
      const sample = (f) => nodeFs.readFileSync(nodePath.join(__dirname, '..', 'samples', f));
      await page.goto(app + '/'); await settle();
      const upload = async (name, mimeType, buffer) => {
        await page.locator('.adder input[type=file]').setInputFiles({ name, mimeType, buffer });
        await page.locator('.adder form button[type=submit]').click();
        await page.getByRole('button', { name: `View ${name} page 1` }).waitFor({ timeout: 20000 }); // OCR runs synchronously on the server
      };
      await upload('ocr_clean_scan.png', 'image/png', sample('pharmacy_bill_scan_corrected.png'));
      await upload('ocr_poor_scan.png', 'image/png', sample('poor_scan_unreadable.png'));
      if (!ocrLib.detect().available) {
        assert.ok(await page.getByText(/OCR is not available here/).first().isVisible());
        return;
      }
      assert.ok(await page.getByText(/read with local OCR/).first().isVisible(), 'upload hint says OCR is local');
      await page.getByText(/OCR \d+%/).first().waitFor(); // confidence chip shown
      await page.getByText(/OCR rejected \(\d+%\)/).first().waitFor(); // rejected chip shown
      await page.getByRole('button', { name: 'View ocr_clean_scan.png page 1' }).click();
      const banner = page.locator('dialog .hint').first();
      await banner.waitFor();
      assert.match(await banner.innerText(), /read by local OCR.*mean confidence \d+%.*No AI model was used/s);
      assert.doesNotMatch(await page.locator('dialog').first().innerText(), /\bnull\b/, 'no stray "null" text in the dialog');
      await page.screenshot({ path: nodePath.join(__dirname, '..', 'docs', 'screenshots', '07-ocr-page-viewer.png') });
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'View ocr_poor_scan.png page 1' }).click();
      await page.locator('dialog .hint').first().waitFor();
      assert.match(await page.locator('dialog').first().innerText(), /discarded and the page counts as unreadable/);
      await page.keyboard.press('Escape');
    });
  } catch (e) { console.error(e); }

  /* ---------- mobile ---------- */
  const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
  const m = await ctxM.newPage();
  m.setDefaultTimeout(8000);
  watch(m, 'mobile');
  const overflow = async () => m.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, wide: [...document.querySelectorAll('main *')].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1 && !el.closest('.table-wrap, pre, dialog, .stepper')).slice(0, 3).map((el) => el.tagName + '.' + el.className) }));
  try {
    await r.step('mobile 390px: claimant workspace has no horizontal overflow and tables stack', async () => {
      await m.goto(app + '/'); await m.waitForSelector('main:not([aria-busy="true"])'); await m.waitForTimeout(200);
      const o = await overflow();
      assert.ok(o.sw <= o.iw + 1, `scrollWidth ${o.sw} > ${o.iw}`);
      assert.deepEqual(o.wide, []);
      assert.ok((await m.locator('table.stack td[data-label]').first().isVisible()));
      await m.screenshot({ path: path.join(SHOTS, '05-claimant-mobile.png') });
    });
    await r.step('mobile 390px: reviewer case view and dashboard fit the screen', async () => {
      await m.locator('[data-fid="role-reviewer"]').click(); await m.waitForTimeout(250);
      await m.goto(app + '/#/intake/case'); await m.waitForTimeout(400);
      let o = await overflow();
      assert.ok(o.sw <= o.iw + 1, `case scrollWidth ${o.sw} > ${o.iw}`);
      await m.screenshot({ path: path.join(SHOTS, '06-reviewer-case-mobile.png') });
      await m.goto(app + '/#/dashboard'); await m.waitForTimeout(400);
      o = await overflow();
      assert.ok(o.sw <= o.iw + 1, `dashboard scrollWidth ${o.sw} > ${o.iw}`);
    });
    await r.step('mobile 390px: modal dialog fits and is usable', async () => {
      await m.locator('[data-fid="role-claimant"]').click(); await m.waitForTimeout(300);
      await m.getByRole('button', { name: /View source claim_form\.txt page 1/ }).first().click();
      const box = await m.locator('dialog[open]').boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= 391, JSON.stringify(box));
    });
  } catch (e) { console.error(e); }

  await r.step('no console errors/warnings, page errors, failed requests or HTTP 5xx during the whole run', async () => {
    assert.deepEqual(problems, []);
  });
  await r.step('server log has no stack traces and no document content', async () => {
    const log = srv.logs.join('');
    assert.doesNotMatch(log, /Error:|\[stderr\]|Grand Total|Aarav/);
  });
  await browser.close();
  await srv.stop(); srv.cleanup();
  if (fe && fe.stop) await fe.stop();
  if (distDir) fs.rmSync(distDir, { recursive: true, force: true });
  process.exit(r.done());
})().catch((e) => { console.error(e); process.exit(1); });
