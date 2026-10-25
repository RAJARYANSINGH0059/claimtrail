import { h, btn, modal } from './ui.js';
import { claimantView } from './claimant.js';
import { queueView, caseView, dashboardView } from './intake.js';
import { auditView } from './components.js';

const ROLE_KEY = 'claimtrail.role';
let role = 'claimant';
try { const r = sessionStorage.getItem(ROLE_KEY); if (r === 'claimant' || r === 'reviewer') role = r; } catch { /* storage unavailable: default role */ }

const ROUTES = {
  claimant: [['#/claimant', 'Workspace'], ['#/audit', 'Audit trail']],
  reviewer: [['#/intake', 'Queue'], ['#/intake/case', 'Case review'], ['#/dashboard', 'Dashboard'], ['#/audit', 'Audit trail']],
};
const DEFAULT = { claimant: '#/claimant', reviewer: '#/intake' };
const $ = (id) => document.getElementById(id);

const ctx = { role, snap: null, queue: null, dashboard: null, samples: [], api, act, refresh, download, announce, fail };

async function api(method, path, body) {
  const headers = { 'X-Role': ctx.role };
  const opts = { method, headers };
  if (method === 'POST' || method === 'PATCH') { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body === undefined ? {} : body); }
  let res;
  try { res = await fetch(path, opts); } catch { throw Object.assign(new Error('Could not reach the local ClaimTrail server. Is it still running?'), { code: 'NETWORK' }); }
  if (!res.ok) {
    let e = { code: `HTTP_${res.status}`, message: `Request failed (${res.status}).` };
    try { e = (await res.json()).error || e; } catch { /* keep default */ }
    throw Object.assign(new Error(e.message), { code: e.code, details: e.details });
  }
  return res.json();
}

function announce(msg) { const el = $('live'); el.textContent = ''; el.textContent = msg || ''; }
function clearError() { const a = $('alert'); a.hidden = true; a.replaceChildren(); }
function fail(e) {
  const a = $('alert');
  a.hidden = false;
  a.replaceChildren(h('strong', {}, 'Refused or failed: '), e.message || 'Something went wrong.',
    e.details && e.details.reasons ? h('ul', {}, e.details.reasons.map((r) => h('li', {}, r))) : null,
    h('button', { type: 'button', class: 'btn btn-sm', onclick: clearError }, 'Dismiss'));
}
async function act(fn, okMsg) {
  clearError();
  try { await fn(); await refresh(okMsg); } catch (e) { fail(e); }
}

async function download(path, filename) {
  clearError();
  try {
    const res = await fetch(path, { headers: { 'X-Role': ctx.role } });
    if (!res.ok) { let e = { message: `Download failed (${res.status}).` }; try { e = (await res.json()).error; } catch { /* default */ } throw Object.assign(new Error(e.message), { details: e.details }); }
    const url = URL.createObjectURL(await res.blob());
    const a = h('a', { href: url, download: filename });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    await refresh(`Downloaded ${filename}. This file is a local export, not a submission.`);
  } catch (e) { fail(e); }
}

function currentRoute() {
  let r = location.hash || DEFAULT[ctx.role];
  if (!ROUTES[ctx.role].some(([href]) => href === r)) { r = DEFAULT[ctx.role]; history.replaceState(null, '', r); }
  return r;
}

async function refresh(msg) {
  try {
    ctx.snap = await api('GET', '/api/state');
    ctx.samples = (await api('GET', '/api/samples')).samples;
    const r = currentRoute();
    if (r === '#/intake') ctx.queue = await api('GET', '/api/queue');
    if (r === '#/dashboard') ctx.dashboard = await api('GET', '/api/dashboard');
  } catch (e) { render(e); return; }
  render();
  if (msg) announce(msg);
}

function switchRole(next) {
  if (next === ctx.role) return;
  ctx.role = next;
  try { sessionStorage.setItem(ROLE_KEY, next); } catch { /* ignore */ }
  clearError();
  if (location.hash === DEFAULT[next]) refresh(`Viewing as ${next === 'claimant' ? 'claimant' : 'intake reviewer'}.`);
  else location.hash = DEFAULT[next];
}

function renderHeader(route) {
  $('topbar').replaceChildren(
    h('div', { class: 'brand' }, h('span', { class: 'logo', 'aria-hidden': 'true' }, '◈'), h('span', { class: 'brand-name' }, 'ClaimTrail'), h('span', { class: 'brand-sub' }, 'Evidence & Intake Assurance')),
    h('span', { class: 'badge-demo' }, 'DEMO DATA'),
    h('div', { class: 'roles', role: 'group', 'aria-label': 'Demo role switch. There is no real login in this MVP.' },
      ['claimant', 'reviewer'].map((r) => h('button', { type: 'button', class: 'role-btn' + (r === ctx.role ? ' active' : ''), 'aria-pressed': String(r === ctx.role), 'data-fid': `role-${r}`, onclick: () => switchRole(r) }, r === 'claimant' ? 'Claimant' : 'Intake reviewer'))),
    h('nav', { 'aria-label': 'Primary' }, ROUTES[ctx.role].map(([href, label]) => h('a', { href, 'aria-current': href === route ? 'page' : null, 'data-fid': `nav-${href}` }, label))));
}

function render(err) {
  const active = document.activeElement;
  const fid = active && active.dataset ? active.dataset.fid : null;
  const route = currentRoute();
  renderHeader(route);
  const main = $('main');
  main.removeAttribute('aria-busy');
  if (err) {
    main.replaceChildren(h('section', { class: 'panel' }, h('h1', {}, 'Could not load the demo'), h('p', { class: 'form-error' }, err.message), btn('Try again', () => refresh(), { kind: 'primary' })));
    return;
  }
  let view;
  if (route === '#/claimant') view = claimantView(ctx);
  else if (route === '#/intake') view = queueView(ctx);
  else if (route === '#/intake/case') view = caseView(ctx);
  else if (route === '#/dashboard') view = dashboardView(ctx);
  else view = auditView(ctx);
  main.replaceChildren(...[view].flat(Infinity).filter(Boolean));
  const labels = { '#/claimant': 'Claimant workspace', '#/intake': 'Intake queue', '#/intake/case': 'Intake case review', '#/dashboard': 'Dashboard (synthetic)', '#/audit': 'Audit trail' };
  document.title = `${labels[route]} — ClaimTrail (demo)`;
  if (fid) { const el = document.querySelector(`[data-fid="${CSS.escape(fid)}"]`); if (el) el.focus({ preventScroll: true }); }
}

function resetDialog() {
  const m = modal({
    title: 'Reset the demo?',
    body: h('p', {}, 'This deletes everything added in this run (uploads, proofs, notes, drafts, history) and restores the original fictional fixture.'),
    actions: [btn('Reset demo data', async () => {
      m.close();
      clearError();
      try { await api('POST', '/api/reset'); location.hash = DEFAULT[ctx.role]; await refresh('Demo reset to the original fixture.'); } catch (e) { fail(e); }
    }, { kind: 'primary' })],
  });
}

$('reset-btn').addEventListener('click', resetDialog);
window.addEventListener('hashchange', () => refresh());
refresh();
