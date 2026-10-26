import { h, chip, btn, field, modal, errorBox, showFormError } from './ui.js';
import { guidancePanel } from './cloud.js';
import { guideSection, stepper, nextActionBox, transitionsPanel, requirementsSection, documentsSection, findingsSection, draftsSection } from './components.js';

function extractDialog(ctx) {
  const body = h('div', {}, h('p', { class: 'muted' }, 'Reading the insurer request…'));
  const m = modal({ title: 'Candidate requirements from the insurer request', body, wide: true });
  ctx.api('POST', '/api/requirements/extract', { text: ctx.snap.case.requestLetter }).then((res) => {
    body.replaceChildren(
      h('p', { class: 'hint' }, `Mode: ${res.mode}${res.live ? '' : ' (no AI model used; keyword rules only)'}. These are suggestions. Nothing is added until you confirm it.`),
      h('ul', { class: 'plain' }, res.candidates.map((c) => {
        const err = errorBox();
        const cat = h('select', {}, [h('option', { value: '' }, 'Choose a category'), ...ctx.snap.limits.categories.map((k) => h('option', { value: k.id, selected: k.id === c.category }, k.label))]);
        return h('li', { class: 'cand' }, h('strong', {}, c.label), h('p', { class: 'hint' }, c.note), field('Category', cat),
          c.alreadyAdded ? chip('matched', 'Already in checklist')
            : btn('Add to checklist', async () => { err.hidden = true; try { await ctx.api('POST', '/api/requirements', { label: c.label, category: cat.value, required: c.required }); m.close(); await ctx.refresh('Requirement added.'); } catch (e) { showFormError(err, e); } }, { small: true }), err);
      })));
  }).catch((e) => { body.replaceChildren(h('p', { class: 'form-error' }, e.message)); });
}

export function claimantView(ctx) {
  const { snap } = ctx;
  const c = snap.case;
  const latestCorrection = snap.drafts.filter((d) => d.kind === 'correction_request').slice(-1)[0];
  return [
    guideSection('claimant'),
    h('section', { class: 'panel', 'aria-labelledby': 'h-top' },
      h('h1', { id: 'h-top' }, 'Claim packet workspace'),
      h('dl', { class: 'meta-grid' },
        h('div', {}, h('dt', {}, 'Case'), h('dd', {}, `${c.id} — ${c.title}`)),
        h('div', {}, h('dt', {}, 'Claimant (fictional)'), h('dd', {}, c.claimant)),
        h('div', {}, h('dt', {}, 'Insurer (fictional)'), h('dd', {}, c.insurer)),
        h('div', {}, h('dt', {}, 'Policy / claim ref'), h('dd', {}, `${c.policyNo} / ${c.claimRef}`)),
        h('div', {}, h('dt', {}, 'Status'), h('dd', {}, h('strong', {}, c.statusLabel)))),
      stepper(snap), nextActionBox(snap),
      h('div', { class: 'ready ' + (snap.readiness.ready ? 'is-ok' : 'is-bad') },
        h('h3', {}, 'Packet readiness ', snap.readiness.ready ? chip('match', 'Ready') : chip('mismatch', 'Not ready')),
        snap.readiness.blockers.length ? h('ul', {}, snap.readiness.blockers.map((b) => h('li', {}, b))) : h('p', {}, 'No readiness blockers.'),
        snap.readiness.warnings.length ? [h('p', { class: 'hint' }, 'Warnings (do not block, but intake will see them):'), h('ul', {}, snap.readiness.warnings.map((b) => h('li', {}, b)))] : null)),
    guidancePanel(ctx),
    c.status === 'action_required' && latestCorrection ? h('section', { class: 'panel callout', 'aria-labelledby': 'h-corr' }, h('h2', { id: 'h-corr' }, 'Correction requested by the intake reviewer'),
      h('p', { class: 'muted' }, 'This is the reviewer’s draft request (demo mode: nothing was actually sent). Add corrected evidence below, then record the resubmission with proof.'),
      h('pre', { class: 'source' }, latestCorrection.body)) : null,
    transitionsPanel(ctx),
    h('section', { class: 'panel', 'aria-labelledby': 'h-req0' },
      h('h2', { id: 'h-req0' }, 'Insurer request'),
      h('details', {}, h('summary', {}, 'Show the request letter (fictional)'), h('pre', { class: 'source' }, c.requestLetter)),
      snap.can['requirement.extract'] && snap.can['requirement.edit'] ? btn('Extract candidate requirements (rules, no AI)', () => extractDialog(ctx), { fid: 'extract' }) : null),
    requirementsSection(ctx),
    documentsSection(ctx, { manage: true }),
    findingsSection(ctx, { actions: false }),
    h('section', { class: 'panel', 'aria-labelledby': 'h-out' },
      h('h2', { id: 'h-out' }, 'Export and follow-up'),
      h('p', { class: 'notice-inline' }, 'Exporting or drafting does not submit anything. Only a recorded submission with proof changes the status.'),
      h('div', { class: 'actions' },
        btn('Export packet manifest (JSON)', () => ctx.download('/api/export/manifest?format=json', 'claimtrail-packet-manifest.json'), { fid: 'exp-json' }),
        btn('Export packet manifest (Markdown)', () => ctx.download('/api/export/manifest?format=md', 'claimtrail-packet-manifest.md'), { fid: 'exp-md' }),
        btn('Export missing-items checklist (Markdown)', () => ctx.download('/api/export/missing?format=md', 'claimtrail-missing-items.md'), { fid: 'exp-miss' }),
        btn('Draft follow-up message', () => ctx.act(() => ctx.api('POST', '/api/drafts', { kind: 'follow_up' }), 'Follow-up draft created below. It was not sent.'), { kind: 'primary', fid: 'draft-fu' }))),
    draftsSection(ctx, ['follow_up', 'correction_request']),
  ];
}
