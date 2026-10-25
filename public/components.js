import { h, chip, fmtTime, short, kb, pct, btn, field, modal, errorBox, showFormError, readFileB64, textB64, table, row } from './ui.js';

const FIELD_LABELS = { patientName: 'Patient name', policyNo: 'Policy number', claimRef: 'Claim reference', admitDate: 'Admission date', dischargeDate: 'Discharge date', billTotal: 'Bill total', claimedAmount: 'Claimed amount' };

/* ---------- page viewer (provenance) ---------- */
export async function openPage(ctx, docId, n, excerpt) {
  let p;
  try { p = await ctx.api('GET', `/api/documents/${docId}/pages/${n}`); } catch (e) { ctx.fail(e); return; }
  const needle = excerpt && excerpt.replace(/…$/, '').trim();
  const body = h('div', {},
    h('p', { class: 'meta' }, `Page ${p.n} of ${p.of} `, p.readable ? chip('match', 'Readable') : chip('unreadable'), p.superseded ? chip('info', 'Replaced or withdrawn') : null),
    ocrBanner(p),
    p.text
      ? h('pre', { class: 'source', tabindex: '0', 'aria-label': `Text of ${p.name} page ${p.n}` }, p.text.split('\n').map((line) => {
        const hit = needle && line.replace(/\s+/g, ' ').trim().startsWith(needle.replace(/\s+/g, ' ').slice(0, 60));
        return hit ? h('mark', {}, line + '\n') : line + '\n';
      }))
      : h('p', { class: 'empty' }, p.isImage ? imageEmptyText(p) : '(this page has no text)'),
    excerpt ? h('p', { class: 'hint' }, 'Highlighted line is the cited source excerpt.') : null);
  const nav = [];
  if (p.n > 1) nav.push(btn('Previous page', () => { m.close(); openPage(ctx, docId, p.n - 1, null); }, { small: true }));
  if (p.n < p.of) nav.push(btn('Next page', () => { m.close(); openPage(ctx, docId, p.n + 1, null); }, { small: true }));
  const m = modal({ title: p.name, body, actions: nav, wide: true });
}

export function cites(ctx, ev) {
  if (!ev || !ev.length) return h('span', { class: 'muted' }, 'No document: the required evidence is absent.');
  return h('ul', { class: 'plain' }, ev.map((e) => h('li', {},
    btn(`${e.docName} p.${e.page}`, () => openPage(ctx, e.docId, e.page, e.excerpt), { small: true, aria: `View source ${e.docName} page ${e.page}` }),
    e.excerpt ? h('q', { class: 'excerpt' }, e.excerpt) : null)));
}

/* ---------- lifecycle ---------- */
export function stepper(snap) {
  const cur = snap.lifecycle.states.findIndex((s) => s.id === snap.lifecycle.current);
  return h('ol', { class: 'stepper', 'aria-label': 'Case lifecycle' }, snap.lifecycle.states.map((s, i) =>
    h('li', { class: 'step' + (i === cur ? ' current' : i < cur ? ' done' : ''), 'aria-current': i === cur ? 'step' : null },
      h('span', { class: 'step-n', 'aria-hidden': 'true' }, i < cur ? '✓' : String(i + 1)), h('span', {}, s.label), i === cur ? h('span', { class: 'sr-only' }, ' (current)') : null)));
}

export function nextActionBox(snap) {
  return h('div', { class: 'next' }, h('strong', {}, 'Next action: '), snap.nextAction,
    snap.waitingOn ? h('p', { class: 'muted' }, `Waiting on the ${snap.waitingOn.role}: ${snap.waitingOn.actions.join(' / ')}`) : null,
    h('p', { class: 'hint' }, 'Status describes document preparation and intake checks only. It is not an insurance decision.'));
}

function proofDialog(ctx, t) {
  const err = errorBox();
  const ref = h('input', { type: 'text', autocomplete: 'off', placeholder: 'e.g. SUB-DEMO-0001', maxlength: '40' });
  const file = h('input', { type: 'file' });
  let synthetic = null;
  const chosen = h('p', { class: 'hint', 'aria-live': 'polite' }, 'No proof file chosen yet.');
  file.addEventListener('change', () => { synthetic = null; chosen.textContent = file.files[0] ? `Chosen: ${file.files[0].name}` : 'No proof file chosen yet.'; });
  const fill = () => {
    const n = ctx.snap.submissions.length + 1;
    ref.value = `SUB-DEMO-${String(n).padStart(4, '0')}`;
    synthetic = { fileName: 'submission_receipt_synthetic.txt', dataBase64: textB64(`SYNTHETIC SUBMISSION RECEIPT - FICTIONAL, GENERATED FOR THE DEMO\nReference: ${ref.value}\nThis receipt does not come from any real insurer or system.\n`) };
    file.value = '';
    chosen.textContent = 'Chosen: submission_receipt_synthetic.txt (fictional, generated here)';
  };
  const submit = async () => {
    err.hidden = true;
    try {
      let proof;
      if (synthetic) proof = { reference: ref.value, ...synthetic };
      else if (file.files[0]) proof = { reference: ref.value, fileName: file.files[0].name, dataBase64: await readFileB64(file.files[0]) };
      else proof = { reference: ref.value };
      await ctx.api('POST', '/api/transition', { to: t.to, proof });
      m.close();
      await ctx.refresh(`Status is now ${t.toLabel}.`);
    } catch (e) { showFormError(err, e); }
  };
  const m = modal({
    title: t.label,
    body: h('div', {},
      h('p', {}, 'ClaimTrail does not send anything to an insurer. Record the reference you received through the insurer’s own channel and attach the receipt or acknowledgement. Without both, the status cannot change.'),
      field('Insurer reference', ref, '6 to 40 letters, digits, "-", "_" or "/". Each reference can be used once.'),
      field('Proof file (receipt / acknowledgement)', file, 'Text, PDF or image, up to 200 KB.'), chosen,
      btn('Use a fictional sample reference and receipt (demo)', fill, { small: true }), err),
    actions: [btn('Record', submit, { kind: 'primary' })],
  });
  return m;
}

export function transitionsPanel(ctx) {
  const { snap } = ctx;
  const items = snap.transitions;
  return h('section', { class: 'panel', 'aria-labelledby': 'h-life' },
    h('h2', { id: 'h-life' }, 'Status actions'),
    items.length ? items.map((t) => h('div', { class: 'action-block' },
      btn(t.label, () => {
        if (t.requiresProof && t.allowed) return proofDialog(ctx, t);
        return ctx.act(() => ctx.api('POST', '/api/transition', { to: t.to }), `Status is now ${t.toLabel}.`);
      }, { kind: t.allowed ? 'primary' : '', blocked: !t.allowed, fid: `tr-${t.to}` }),
      !t.allowed ? h('div', { class: 'blocked' }, h('p', {}, h('strong', {}, 'Blocked: '), 'this action is refused until:'), h('ul', {}, t.blockedReasons.map((r) => h('li', {}, r)))) : null,
      t.requiresProof && t.allowed ? h('p', { class: 'hint' }, 'Needs an insurer reference and a proof file; the next step asks for them.') : null))
      : h('p', { class: 'muted' }, snap.waitingOn ? `No action for you right now. Waiting on the ${snap.waitingOn.role}.` : 'No further status actions. Intake checks are complete (this is not a coverage decision).'),
    snap.submissions.length ? h('div', {}, h('h3', {}, 'Submission records (proof on file)'), table(['#', 'Kind', 'Reference', 'Proof file', 'Recorded'],
      snap.submissions.map((s) => row(['#', 'Kind', 'Reference', 'Proof file', 'Recorded'], [s.n, s.kind, h('code', {}, s.reference), `${s.proof.fileName} (SHA-256 ${short(s.proof.sha256)}…)`, fmtTime(s.at)])), { caption: 'Submission records' })) : null);
}

/* ---------- requirements / evidence matrix ---------- */
function rejectDialog(ctx, link) {
  const err = errorBox();
  const note = h('textarea', { rows: '3', maxlength: '1000' });
  const m = modal({
    title: 'Reject this match', body: h('div', {}, field('Reason (required, at least 5 characters)', note), err),
    actions: [btn('Reject match', async () => { err.hidden = true; try { await ctx.api('POST', `/api/links/${link.id}/decision`, { decision: 'rejected', note: note.value }); m.close(); await ctx.refresh('Match rejected.'); } catch (e) { showFormError(err, e); } }, { kind: 'primary' })],
  });
}
function chooseDialog(ctx, st) {
  const err = errorBox();
  const docs = ctx.snap.documents.filter((d) => !d.supersededBy);
  const sel = h('select', {}, docs.map((d) => h('option', { value: d.id }, `${d.id} ${d.name}`)));
  const page = h('input', { type: 'number', min: '1', value: '1' });
  const m = modal({
    title: `Choose evidence for: ${st.label}`,
    body: h('div', {}, field('Document', sel), field('Page number', page, 'The page you choose becomes the cited source.'), err),
    actions: [btn('Use this page', async () => { err.hidden = true; try { await ctx.api('POST', '/api/links/manual', { reqId: st.reqId, docId: sel.value, page: Number(page.value) }); m.close(); await ctx.refresh('Evidence chosen.'); } catch (e) { showFormError(err, e); } }, { kind: 'primary' })],
  });
}
function editReqDialog(ctx, r) {
  const err = errorBox();
  const label = h('input', { type: 'text', value: r.label, maxlength: '80' });
  const cat = h('select', {}, ctx.snap.limits.categories.map((c) => h('option', { value: c.id, selected: c.id === r.category }, c.label)));
  const m = modal({
    title: 'Edit requirement', body: h('div', {}, field('Label', label), field('Evidence category', cat), err),
    actions: [btn('Save', async () => { err.hidden = true; try { await ctx.api('PATCH', `/api/requirements/${r.id}`, { label: label.value, category: cat.value }); m.close(); await ctx.refresh('Requirement updated.'); } catch (e) { showFormError(err, e); } }, { kind: 'primary' })],
  });
}

export function requirementsSection(ctx) {
  const { snap } = ctx;
  const reqs = new Map(snap.requirements.map((r) => [r.id, r]));
  const canDecide = snap.can['link.decide'];
  const canEdit = snap.can['requirement.edit'];
  const H = ['Requirement', 'Status', 'Evidence and source', 'Why', 'Actions'];
  const rows = snap.statuses.map((st) => {
    const r = reqs.get(st.reqId);
    const link = snap.links.find((l) => l.id === st.linkId);
    const doc = snap.documents.find((d) => d.id === st.docId);
    const evidence = doc
      ? h('div', {}, btn(`${doc.name} p.${st.page}`, () => openPage(ctx, doc.id, st.page, st.excerpt), { small: true, aria: `View source ${doc.name} page ${st.page}` }),
        st.excerpt ? h('q', { class: 'excerpt' }, st.excerpt) : null,
        h('p', { class: 'hint' }, `Confidence ${pct(st.confidence)} · ${link && link.decision === 'accepted' ? `accepted by ${link.decidedBy}` : link && link.decision === 'rejected' ? 'rejected' : 'suggested by rules, not yet confirmed by a person'}${st.candidates > 1 ? ` · ${st.candidates} candidate documents` : ''}`))
      : h('span', { class: 'muted' }, 'No evidence linked');
    const actions = h('div', { class: 'actions' },
      canDecide && link && link.decision !== 'accepted' && st.docId ? btn('Accept', () => ctx.act(() => ctx.api('POST', `/api/links/${link.id}/decision`, { decision: 'accepted' }), 'Match accepted.'), { small: true, fid: `acc-${st.reqId}` }) : null,
      canDecide && link && link.decision !== 'rejected' && st.docId ? btn('Reject', () => rejectDialog(ctx, link), { small: true, fid: `rej-${st.reqId}` }) : null,
      canDecide ? btn('Choose evidence', () => chooseDialog(ctx, st), { small: true, fid: `cho-${st.reqId}` }) : null,
      canEdit ? btn('Edit', () => editReqDialog(ctx, r), { small: true, fid: `edr-${st.reqId}` }) : null,
      canEdit ? btn('Remove', () => ctx.act(() => ctx.api('DELETE', `/api/requirements/${r.id}`), 'Requirement removed.'), { small: true, fid: `rmr-${st.reqId}` }) : null);
    return row(H, [
      h('div', {}, h('strong', {}, r.label), h('p', { class: 'hint' }, `${r.id} · category ${r.category}`),
        canEdit ? h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: r.required, 'data-fid': `req-${r.id}`, onchange: (e) => ctx.act(() => ctx.api('PATCH', `/api/requirements/${r.id}`, { required: e.target.checked }), 'Requirement updated.') }), 'Required')
          : h('span', { class: 'hint' }, r.required ? 'Required' : 'Optional')),
      h('div', {}, chip(st.status), st.duplicate ? chip('duplicate') : null),
      evidence, h('span', {}, st.explanation), actions,
    ]);
  });
  const label = h('input', { type: 'text', maxlength: '80', autocomplete: 'off' });
  const cat = h('select', {}, snap.limits.categories.map((c) => h('option', { value: c.id }, c.label)));
  const req = h('input', { type: 'checkbox', checked: true });
  const err = errorBox();
  return h('section', { class: 'panel', 'aria-labelledby': 'h-req' },
    h('h2', { id: 'h-req' }, 'Requirements and evidence'),
    h('p', { class: 'muted' }, 'Each insurer requirement is mapped to a document page. Matches come from deterministic rules; a person confirms them.'),
    snap.can['link.acceptAll'] ? h('div', { class: 'actions' }, btn('Accept all clean suggested matches', () => ctx.act(() => ctx.api('POST', '/api/links/accept-suggested'), 'Clean suggested matches accepted. Items needing a person were left alone.'), { fid: 'accept-all' }), h('span', { class: 'hint' }, 'Only matched, readable pages with a valid source are accepted. Missing, unreadable, ambiguous and low-confidence items are skipped.')) : null,
    snap.statuses.length ? table(H, rows, { caption: 'Requirements mapped to evidence', cls: 'stack' }) : h('p', { class: 'empty' }, 'No requirements yet. Add one below or extract candidates from the insurer request.'),
    canEdit ? h('form', { class: 'inline-form', onsubmit: async (e) => { e.preventDefault(); err.hidden = true; try { await ctx.api('POST', '/api/requirements', { label: label.value, category: cat.value, required: req.checked }); await ctx.refresh('Requirement added.'); } catch (x) { showFormError(err, x); } } },
      h('h3', {}, 'Add a requirement'), field('Label', label), field('Evidence category', cat), h('label', { class: 'inline' }, req, 'Required'), h('button', { type: 'submit', class: 'btn' }, 'Add requirement'), err) : null);
}

/* ---------- comparisons ---------- */
export function comparisonSection(ctx) {
  const { snap } = ctx;
  const H = ['Field', 'Document A', 'Document B', 'Result', 'Explanation'];
  const side = (s) => (s.page ? h('div', {}, btn(`${s.docName} p.${s.page}`, () => openPage(ctx, s.docId, s.page, s.excerpt), { small: true }), h('p', {}, h('code', {}, s.value))) : h('div', {}, s.docName, h('p', { class: 'muted' }, 'not found')));
  return h('section', { class: 'panel', 'aria-labelledby': 'h-cmp' },
    h('h2', { id: 'h-cmp' }, 'Cross-document comparison'),
    h('p', { class: 'muted' }, 'A difference is a documentation inconsistency for a person to review. It is never treated as fraud or as a coverage decision.'),
    snap.comparisons.length ? table(H, snap.comparisons.map((c) => row(H, [c.label, side(c.ref), side(c.other), h('div', {}, chip(c.status), h('p', { class: 'hint' }, h('code', {}, c.reasonCode))), c.explanation])), { caption: 'Cross-document field comparison', cls: 'stack' })
      : h('p', { class: 'empty' }, 'Nothing to compare yet: comparisons need matched evidence for at least two requirements.'));
}

/* ---------- findings ---------- */
function resolveDialog(ctx, f) {
  const err = errorBox();
  const note = h('textarea', { rows: '3', maxlength: '1000' });
  const m = modal({
    title: 'Resolve with a note',
    body: h('div', {}, h('p', {}, h('strong', {}, f.title), ` [${f.code}]`), h('p', { class: 'hint' }, 'This is a reviewer override. The note is recorded in the audit trail and the final report. If the cited evidence is replaced, the checks run again on the new evidence and may raise a new finding. You can also reopen this one manually.'),
      field('Resolution note (required, at least 5 characters)', note), err),
    actions: [btn('Resolve finding', async () => { err.hidden = true; try { await ctx.api('POST', '/api/findings/resolve', { key: f.key, note: note.value }); m.close(); await ctx.refresh('Finding resolved with a note.'); } catch (e) { showFormError(err, e); } }, { kind: 'primary' })],
  });
}
function reopenDialog(ctx, f) {
  const err = errorBox();
  const note = h('textarea', { rows: '3', maxlength: '1000' });
  const m = modal({
    title: 'Reopen finding', body: h('div', {}, h('p', {}, f.title), field('Reason (required, at least 5 characters)', note), err),
    actions: [btn('Reopen', async () => { err.hidden = true; try { await ctx.api('POST', '/api/findings/reopen', { key: f.key, note: note.value }); m.close(); await ctx.refresh('Finding reopened.'); } catch (e) { showFormError(err, e); } }, { kind: 'primary' })],
  });
}

export function findingsSection(ctx, { actions }) {
  const { snap } = ctx;
  const H = ['Reason code', 'Finding and why', 'Source', 'History', actions ? 'Actions' : null].filter(Boolean);
  const open = snap.findings.filter((f) => f.status === 'open');
  const resolved = snap.findings.filter((f) => f.status === 'resolved');
  const mk = (f) => {
    const cells = [
      h('div', {}, h('code', { class: 'rc' }, f.code), h('div', {}, chip(f.severity), chip(f.status))),
      h('div', {}, h('strong', {}, f.title), h('p', {}, f.explanation)),
      cites(ctx, f.evidence),
      h('div', {}, h('p', { class: 'hint' }, `First seen ${fmtTime(f.firstSeenAt)}${f.reopenCount ? ` · reopened ${f.reopenCount}×` : ''}`),
        f.resolution ? h('p', {}, f.resolution.kind === 'reviewer_note' ? `Reviewer override by ${f.resolution.by}: “${f.resolution.note}”` : 'Resolved automatically: the evidence changed.') : null),
    ];
    if (actions) {
      cells.push(snap.can['finding.resolve']
        ? (f.status === 'open'
          ? (f.code === 'PROVENANCE_MISSING' ? h('span', { class: 'hint' }, 'Not overridable: fix the evidence link.') : btn('Resolve with note', () => resolveDialog(ctx, f), { small: true, fid: `res-${f.key}` }))
          : btn('Reopen', () => reopenDialog(ctx, f), { small: true, fid: `reo-${f.key}` }))
        : h('span', { class: 'hint' }, 'Not available in this status or role.'));
    }
    return row(H, cells, f.status === 'resolved' ? 'is-resolved' : '');
  };
  const blocking = open.filter((f) => f.severity !== 'info').length;
  return h('section', { class: 'panel', 'aria-labelledby': 'h-find' },
    h('h2', { id: 'h-find' }, 'Findings'),
    h('p', { class: 'muted' }, `${open.length} open (${blocking} blocking) · ${resolved.length} resolved. Every finding cites a document page or says which evidence is absent.`),
    open.length ? [h('h3', {}, 'Open'), table(H, open.map(mk), { caption: 'Open findings', cls: 'stack' })] : h('p', { class: 'empty' }, 'No open findings.'),
    resolved.length ? [h('h3', {}, 'Resolved (history is kept)'), table(H, resolved.map(mk), { caption: 'Resolved findings', cls: 'stack' })] : null);
}

/* ---------- documents ---------- */
function deliveryDialog(ctx, d) {
  const err = errorBox();
  const status = h('select', {}, [['not_sent', 'Not sent'], ['sent_claimed', 'Sent (claim only, no proof)'], ['acknowledged', 'Acknowledged (needs reference and proof file)']].map(([v, l]) => h('option', { value: v, selected: v === d.delivery.status }, l)));
  const ref = h('input', { type: 'text', maxlength: '40', placeholder: 'e.g. ACK-DEMO-0001' });
  const file = h('input', { type: 'file' });
  let synth = null;
  file.addEventListener('change', () => { synth = null; });
  const m = modal({
    title: `Delivery of ${d.name}`,
    body: h('div', {}, h('p', {}, 'Claiming something was sent is not proof. Only an acknowledgement reference plus an attached receipt counts as acknowledged.'),
      field('Delivery status', status), field('Acknowledgement reference', ref), field('Proof file', file),
      btn('Use a fictional sample reference and receipt (demo)', () => { ref.value = `ACK-DEMO-${d.id.slice(2)}`; synth = { fileName: 'ack_receipt_synthetic.txt', dataBase64: textB64(`SYNTHETIC ACKNOWLEDGEMENT RECEIPT - FICTIONAL\nReference: ${ref.value}\n`) }; }, { small: true }), err),
    actions: [btn('Save', async () => {
      err.hidden = true;
      try {
        const body = { status: status.value };
        if (status.value === 'acknowledged') { body.reference = ref.value; if (synth) Object.assign(body, synth); else if (file.files[0]) { body.fileName = file.files[0].name; body.dataBase64 = await readFileB64(file.files[0]); } }
        await ctx.api('POST', `/api/documents/${d.id}/delivery`, body); m.close(); await ctx.refresh('Delivery updated.');
      } catch (e) { showFormError(err, e); }
    }, { kind: 'primary' })],
  });
}
function replaceDialog(ctx, d) {
  const err = errorBox();
  const file = h('input', { type: 'file', accept: ctx.snap.limits.extensions.join(',') });
  const m = modal({
    title: `Replace ${d.name}`, body: h('div', {}, h('p', {}, 'The old version stays in history. A diff of extracted fields is recorded.'), field('Corrected file', file), err),
    actions: [btn('Upload replacement', async () => { err.hidden = true; try { if (!file.files[0]) throw new Error('Choose a file first.'); await ctx.api('POST', '/api/documents', { name: file.files[0].name, dataBase64: await readFileB64(file.files[0]), replaces: d.id }); m.close(); await ctx.refresh('Document replaced.'); } catch (e) { showFormError(err, e); } }, { kind: 'primary' })],
  });
}
function withdrawDialog(ctx, d) {
  const err = errorBox();
  const note = h('textarea', { rows: '3', maxlength: '1000' });
  const m = modal({
    title: `Withdraw ${d.name}`, body: h('div', {}, h('p', {}, 'Use this for an unwanted copy. It stays visible in history.'), field('Reason (required, at least 5 characters)', note), err),
    actions: [btn('Withdraw document', async () => { err.hidden = true; try { await ctx.api('POST', `/api/documents/${d.id}/withdraw`, { reason: note.value }); m.close(); await ctx.refresh('Document withdrawn.'); } catch (e) { showFormError(err, e); } }, { kind: 'primary' })],
  });
}

const FIELD_ORDER = ['patientName', 'claimedAmount', 'billTotal'];
function diffView(d) {
  const x = d.replaceDiff;
  if (!x) return null;
  return h('details', { class: 'diff' }, h('summary', {}, `Re-upload diff vs ${d.replaces}`),
    h('ul', {}, h('li', {}, `Pages: ${x.pages.from} → ${x.pages.to}; readable pages: ${x.readablePages.from} → ${x.readablePages.to}`),
      h('li', {}, `Detected type: ${x.type.from} → ${x.type.to}`),
      x.fields.length ? x.fields.map((f) => h('li', {}, `${f.label}: ${f.from ?? 'none'} → ${f.to ?? 'none'} (${f.change})`)) : h('li', {}, 'No extracted field changed.'),
      h('li', {}, `${x.unchangedFields} extracted field(s) unchanged.`)));
}

export function evidenceAdder(ctx) {
  const { snap } = ctx;
  if (!snap.can['document.add']) return h('p', { class: 'hint' }, 'Evidence can’t be added in this role or status.');
  const err = errorBox();
  const file = h('input', { type: 'file', accept: snap.limits.extensions.join(',') });
  const samples = ctx.samples || [];
  return h('div', { class: 'adder' },
    h('h3', {}, 'Add evidence'),
    h('form', { class: 'inline-form', onsubmit: async (e) => { e.preventDefault(); err.hidden = true; try { const f = file.files[0]; if (!f) throw new Error('Choose a file first.'); await ctx.api('POST', '/api/documents', { name: f.name, dataBase64: await readFileB64(f) }); await ctx.refresh(`Added ${f.name}.`); } catch (x) { showFormError(err, x); } } },
      field('Upload a file', file, `Allowed: ${snap.limits.extensions.join(' ')}; up to ${kb(snap.limits.maxUploadBytes)}. Text is read on this machine only. ${snap.ocr && snap.ocr.available ? `Images and PDFs are read with local OCR (${snap.ocr.engine}); no model or network is used, and low-confidence pages are flagged or rejected.` : `OCR is not available here (${(snap.ocr && snap.ocr.reason) || 'not installed'}), so images and PDFs are stored by hash and count as unreadable.`}`),
      h('button', { type: 'submit', class: 'btn' }, 'Upload'), err),
    h('h4', {}, 'Or use a fictional sample document'),
    h('ul', { class: 'plain samples' }, samples.map((s) => h('li', {}, btn(s.used ? `${s.title} (added)` : s.title, () => ctx.act(() => ctx.api('POST', '/api/documents/sample', { sampleId: s.id }), `Added ${s.title}.`), { small: true, disabled: s.used, fid: `smp-${s.id}` }),
      h('span', { class: 'hint' }, ` ${s.note}`)))));
}

export function documentsSection(ctx, { manage }) {
  const { snap } = ctx;
  const active = snap.documents.filter((d) => !d.supersededBy);
  const old = snap.documents.filter((d) => d.supersededBy);
  const H = ['Document', 'Detected type', 'Pages', 'Delivery', manage ? 'Actions' : null].filter(Boolean);
  const dupIds = new Set(snap.dups.flatMap((d) => [d.a, d.b]));
  const mk = (d) => {
    const cells = [
      h('div', {}, h('strong', {}, d.name), h('p', { class: 'hint' }, `${d.id} · ${kb(d.size)} · SHA-256 ${short(d.sha256)}… · added by ${d.addedBy}`), dupIds.has(d.id) && !d.supersededBy ? chip('duplicate') : null, diffView(d)),
      h('div', {}, d.classification.type === 'unknown' ? 'Unclassified' : d.classification.type, h('p', { class: 'hint' }, `confidence ${pct(d.classification.confidence)} · ${d.classification.reasons.join('; ')}`)),
      h('div', {}, d.pages.map((p) => h('div', {}, btn(`Page ${p.n}`, () => openPage(ctx, d.id, p.n, null), { small: true, aria: `View ${d.name} page ${p.n}` }), ' ', p.readable ? chip('match', 'Readable') : chip('unreadable'), ocrChip(p)))),
      d.supersededBy ? h('span', { class: 'muted' }, d.supersededBy === 'WITHDRAWN' ? `Withdrawn: ${d.withdrawn ? d.withdrawn.reason : ''}` : `Replaced by ${d.supersededBy}`)
        : h('div', {}, chip(d.delivery.status), d.delivery.ackRef ? h('p', { class: 'hint' }, `Ref ${d.delivery.ackRef}; proof ${d.delivery.proof.fileName} (${short(d.delivery.proof.sha256)}…)`) : null),
    ];
    if (manage) {
      cells.push(d.supersededBy ? '' : h('div', { class: 'actions' },
        snap.can['document.delivery'] ? btn('Delivery', () => deliveryDialog(ctx, d), { small: true, fid: `del-${d.id}` }) : null,
        snap.can['document.add'] ? btn('Replace', () => replaceDialog(ctx, d), { small: true, fid: `rep-${d.id}` }) : null,
        snap.can['document.withdraw'] ? btn('Withdraw', () => withdrawDialog(ctx, d), { small: true, fid: `wd-${d.id}` }) : null));
    }
    return row(H, cells, d.supersededBy ? 'is-resolved' : '');
  };
  return h('section', { class: 'panel', 'aria-labelledby': 'h-docs' },
    h('h2', { id: 'h-docs' }, 'Documents'),
    active.length ? table(H, active.map(mk), { caption: 'Documents in the packet', cls: 'stack' }) : h('p', { class: 'empty' }, 'No documents yet. Upload a file or use a fictional sample below.'),
    old.length ? h('details', {}, h('summary', {}, `History: ${old.length} replaced or withdrawn`), table(H, old.map(mk), { caption: 'Replaced or withdrawn documents', cls: 'stack' })) : null,
    evidenceAdder(ctx));
}

/* ---------- drafts ---------- */
export function draftsSection(ctx, kinds) {
  const list = ctx.snap.drafts.filter((d) => kinds.includes(d.kind)).slice().reverse();
  return h('section', { class: 'panel', 'aria-labelledby': 'h-draft' },
    h('h2', { id: 'h-draft' }, 'Message drafts'),
    h('p', { class: 'muted' }, 'Drafts are text for a person to review. ClaimTrail has no way to send a message in demo mode.'),
    list.length ? list.map((d) => h('article', { class: 'draft' },
      h('p', { class: 'meta' }, h('strong', {}, 'DRAFT — not sent'), ` · ${d.kind.replace('_', ' ')} · ${d.mode === 'template' ? 'fixed template, no AI model' : d.mode} · ${d.createdBy} · ${fmtTime(d.createdAt)}`),
      h('label', { class: 'sr-only', for: `ta-${d.id}` }, `Draft ${d.id}`),
      h('textarea', { id: `ta-${d.id}`, readonly: true, rows: '12' }, d.body),
      btn('Copy text', async () => { try { await navigator.clipboard.writeText(d.body); ctx.announce('Draft copied.'); } catch { ctx.announce('Copy is unavailable here; select the text and copy it.'); } }, { small: true }))) : h('p', { class: 'empty' }, 'No drafts yet.'));
}

/* ---------- guided demo path + outcome ---------- */
const GUIDE = {
  claimant: [
    'Read the requirements table: each requirement points to a document page (click a source button to see the cited text). One item is missing and one is unreadable.',
    'Press "Mark packet ready for review": it is refused and says why (the lab report is missing).',
    'Add the fictional sample "Diagnostic / lab report" under Add evidence. Export the missing-items checklist and create a follow-up draft (nothing is sent).',
    'Mark the packet ready, then "Record submission": try Record with no reference (refused), then use the fictional sample reference and receipt.',
    'Switch to Intake reviewer (top bar) and continue there.',
  ],
  reviewer: [
    'Queue → Open case → "Start intake review". Read the open findings: each cites a document page or says what evidence is absent.',
    'Press "Accept all clean suggested matches", then resolve the possible duplicate with a note (try an empty note first: refused).',
    '"Request corrections" creates a draft only and moves the case to Action required. Switch to Claimant, add the sample "Readable pharmacy bill" (see its re-upload diff) and "Photo ID with matching full name", then record the resubmission with proof.',
    'Back here: Re-run checks. The claimed-amount mismatch stays open and "Mark intake checks complete" is refused with the reason. Add the sample "Corrected claim form" to see it clear, accept the new matches, and complete.',
    'Open the Dashboard (synthetic figures) and download the intake report.',
  ],
};
export function guideSection(role) {
  return h('details', { class: 'panel guide' },
    h('summary', {}, 'Guided demo path (about 3 minutes)'),
    h('ol', {}, GUIDE[role].map((t) => h('li', {}, t))),
    h('p', { class: 'hint' }, 'Reset demo data (page footer) restores the original fictional case at any time.'));
}

export function outcomePanel(ctx) {
  const { snap } = ctx;
  const blocking = snap.findings.filter((f) => f.status === 'open' && f.severity !== 'info');
  const done = snap.case.status === 'intake_complete';
  return h('section', { class: 'panel outcome ' + (done ? 'is-ok' : 'is-bad'), 'aria-labelledby': 'h-out2' },
    h('h2', { id: 'h-out2' }, 'Intake outcome ', done ? chip('match', 'Intake checks complete') : chip('mismatch', 'Not complete')),
    done ? h('p', {}, 'Configured intake checks passed. This is not a coverage decision, a claim approval, a clinical judgement or a fraud determination.')
      : [h('p', {}, blocking.length ? `${blocking.length} blocking finding(s) are still open, so intake checks cannot be marked complete:` : 'No blocking findings are open.'),
        blocking.length ? h('ul', {}, blocking.map((f) => h('li', {}, h('code', {}, f.code), ` ${f.title}`, h('span', { class: 'hint' }, ` — ${f.evidence.length ? f.evidence.map((e) => `${e.docName} p.${e.page}`).join(' vs ') : 'required evidence absent'}`)))) : null,
        h('p', { class: 'hint' }, 'A difference between documents is a point to review, not a conclusion about the claimant.')]);
}

/* ---------- audit trail ---------- */
export function auditView(ctx) {
  const { snap } = ctx;
  const H = ['#', 'When', 'Actor', 'Event', 'Summary'];
  return h('section', { class: 'panel', 'aria-labelledby': 'h-audit' },
    h('h2', { id: 'h-audit' }, 'Audit trail'),
    h('p', { class: 'muted' }, `${snap.events.length} events. Append-only inside this demo process: nothing here edits or deletes an earlier event. It is stored in a local file and is not cryptographically immutable.`),
    table(H, snap.events.slice().reverse().map((e) => row(H, [e.seq, fmtTime(e.at), e.actor, h('code', {}, e.type), e.summary])), { caption: 'Audit events, newest first', cls: 'stack' }));
}

/* ---------- OCR helpers (labels are explicit that OCR text is machine-read, not a pristine source) ---------- */
function ocrChip(p) {
  const o = p.ocr;
  if (!o || o.method === 'none') return null;
  if (o.status === 'rejected_low_confidence') return chip('needs_review', `OCR rejected (${o.confidence}%)`);
  if (o.status === 'verify') return chip('needs_review', `OCR ${o.confidence}%: verify`);
  if (o.method === 'ocr' && o.status === 'ok') return chip('info', `OCR ${o.confidence}%`);
  if (o.method === 'pdf-text-layer') return chip('info', 'PDF text layer');
  return null;
}
function ocrBanner(p) {
  const o = p.ocr;
  if (!o || o.method === 'none' && o.status !== 'unavailable') return null;
  const note = p.ocrNote ? ` ${p.ocrNote}` : '';
  if (o.status === 'unavailable') return h('p', { class: 'hint' }, 'OCR is not available on this machine, so this image or PDF counts as unreadable.' + note);
  if (o.status === 'rejected_low_confidence') return h('p', { class: 'hint' }, `Local OCR (${o.engine}) read this page with only ${o.confidence}% confidence, so its text was discarded and the page counts as unreadable. Upload a clearer copy.` + note);
  if (o.status === 'failed') return h('p', { class: 'hint' }, 'OCR failed on this page, so it counts as unreadable.' + note);
  if (o.method === 'pdf-text-layer') return h('p', { class: 'hint' }, 'Text taken from the PDF text layer (no OCR needed).' + note);
  return h('p', { class: 'hint' }, `Text read by local OCR (${o.engine}), mean confidence ${o.confidence}%. ` + (o.status === 'verify' ? 'Confidence is low: verify every value against the original image. Differences found in this page are marked "needs review", not "mismatch". ' : 'OCR can still misread digits; verify amounts against the original. ') + 'No AI model was used.' + note);
}
function imageEmptyText(p) {
  const o = p.ocr;
  return o && o.status === 'rejected_low_confidence' ? '(OCR text discarded: confidence too low)' : 'This image or PDF has no extractable text, so the page counts as unreadable.';
}
