import { h, chip, btn, fmtTime, table, row } from './ui.js';
import { guidancePanel } from './cloud.js';
import { guideSection, outcomePanel, stepper, nextActionBox, transitionsPanel, requirementsSection, documentsSection, findingsSection, comparisonSection, draftsSection } from './components.js';

export function queueView(ctx) {
  const q = ctx.queue;
  const H = ['Case', 'Claimant', 'Status', 'Open blockers', 'Next action', 'Age (h)', ''];
  return [guideSection('reviewer'), h('section', { class: 'panel', 'aria-labelledby': 'h-q' },
    h('h1', { id: 'h-q' }, 'Intake queue ', h('span', { class: 'badge-demo' }, 'DEMO DATA')),
    h('p', { class: 'muted' }, 'The first row is the live shared case the claimant workspace edits. The other rows are static synthetic placeholders and cannot be opened.'),
    table(H, q.rows.map((r) => row(H, [
      h('code', {}, r.id), r.claimant, r.statusLabel, h('span', {}, r.openBlockers, ' ', r.openBlockers ? chip('blocker', 'blocking') : chip('match', 'none')), r.nextAction, r.ageHours,
      r.live ? h('a', { class: 'btn btn-primary btn-sm', href: '#/intake/case', 'data-fid': 'open-case' }, 'Open case') : h('span', { class: 'hint' }, 'Static sample row, not openable'),
    ], r.live ? 'is-live' : '')), { caption: 'Intake queue', cls: 'stack' }))];
}

export function caseView(ctx) {
  const { snap } = ctx;
  const c = snap.case;
  const s = snap.summary;
  return [
    h('section', { class: 'panel', 'aria-labelledby': 'h-case' },
      h('h1', { id: 'h-case' }, `Intake review: ${c.id}`),
      h('dl', { class: 'meta-grid' },
        h('div', {}, h('dt', {}, 'Claimant (fictional)'), h('dd', {}, c.claimant)),
        h('div', {}, h('dt', {}, 'Insurer (fictional)'), h('dd', {}, c.insurer)),
        h('div', {}, h('dt', {}, 'Status'), h('dd', {}, h('strong', {}, c.statusLabel))),
        h('div', {}, h('dt', {}, 'Open blocking findings'), h('dd', {}, String(s.openBlockers))),
        h('div', {}, h('dt', {}, 'Analysis mode'), h('dd', {}, snap.meta.ai.cloudDocuments > 0 ? `deterministic rules decide; the text of ${snap.meta.ai.cloudDocuments} document(s) was read by Sarvam Document AI (verify against the original)` : 'deterministic rules (no AI model used)'))),
      stepper(snap), nextActionBox(snap),
      h('div', { class: 'actions' },
        snap.can['checks.rerun'] ? btn('Re-run checks', () => ctx.act(() => ctx.api('POST', '/api/rerun'), 'Checks re-run.'), { fid: 'rerun' }) : null,
        snap.can['draft.correction'] ? btn('Generate correction-request draft', () => ctx.act(() => ctx.api('POST', '/api/drafts', { kind: 'correction_request' }), 'Correction-request draft created below. It was not sent.'), { fid: 'draft-cr' }) : null,
        btn('Download intake report (Markdown)', () => ctx.download('/api/report?format=md', 'claimtrail-intake-report.md'), { fid: 'report-md' }),
        btn('Download intake report (JSON)', () => ctx.download('/api/report?format=json', 'claimtrail-intake-report.json'), { fid: 'report-json' })),
      snap.lastCheck ? h('div', { class: 'check-result', role: 'status' }, h('h3', {}, 'Last re-run'),
        h('p', {}, `${fmtTime(snap.lastCheck.at)} · ${snap.lastCheck.diff.newlyOpen.length} new, ${snap.lastCheck.diff.resolved.length} resolved, ${snap.lastCheck.diff.stillOpen.length} still open · ${snap.lastCheck.openBlockers} blocking`)) : null),
    guidancePanel(ctx),
    transitionsPanel(ctx),
    outcomePanel(ctx),
    findingsSection(ctx, { actions: true }),
    comparisonSection(ctx),
    requirementsSection(ctx),
    documentsSection(ctx, { manage: true }),
    draftsSection(ctx, ['correction_request', 'follow_up']),
  ];
}

export function dashboardView(ctx) {
  const d = ctx.dashboard;
  const H = ['Case', 'Status', 'Open blockers', 'Age (days)', 'Requests', 'Reopened', 'First pass complete', 'Triage (h)'];
  const L = d.live;
  return [
    h('section', { class: 'panel', 'aria-labelledby': 'h-dash' },
      h('h1', { id: 'h-dash' }, 'Operations dashboard ', h('span', { class: 'badge-demo' }, 'SYNTHETIC')),
      h('p', { class: 'notice-inline' }, d.banner),
      h('div', { class: 'tiles' }, d.tiles.map((t) => h('div', { class: 'tile' }, h('p', { class: 'tile-label' }, t.label), h('p', { class: 'tile-value' }, String(t.value), h('span', { class: 'tile-unit' }, ` ${t.unit}`)), h('p', { class: 'hint' }, t.definition), h('p', { class: 'badge-syn' }, 'Synthetic')))),
      h('details', {}, h('summary', {}, 'Show the synthetic rows these tiles are computed from'),
        table(H, d.rows.map((r) => row(H, [h('code', {}, r.id), r.status, r.openBlockers, r.ageDays, r.requestCount, r.reopened ? 'yes' : 'no', r.firstPassComplete ? 'yes' : 'no', r.triageHours])), { caption: 'Synthetic fixture rows', cls: 'stack' }))),
    h('section', { class: 'panel', 'aria-labelledby': 'h-live' },
      h('h2', { id: 'h-live' }, 'This demo case, counted live'),
      h('p', { class: 'muted' }, L.note),
      h('dl', { class: 'meta-grid' },
        h('div', {}, h('dt', {}, 'Open blocking findings'), h('dd', {}, String(L.openBlockers))),
        h('div', {}, h('dt', {}, 'Oldest open blocker'), h('dd', {}, `${L.oldestOpenBlockerMinutes} min`)),
        h('div', {}, h('dt', {}, 'Correction rounds'), h('dd', {}, String(L.correctionRounds))),
        h('div', {}, h('dt', {}, 'Time to triage'), h('dd', {}, L.timeToTriageMinutes === null ? 'not yet triaged' : `${L.timeToTriageMinutes} min`)),
        h('div', {}, h('dt', {}, 'Resolved by new evidence'), h('dd', {}, String(L.resolvedByEvidence))),
        h('div', {}, h('dt', {}, 'Resolved by reviewer note'), h('dd', {}, String(L.resolvedByReviewer))))),
  ];
}
