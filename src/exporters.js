'use strict';
/** Pure builders for exports and the intake report. Exporting is NOT submission. */
const MODE_NOTE = 'deterministic rules (no AI model used)';
/** Truthful mode line: once a Sarvam-read document is in the packet, "no AI model used" would be false. */
function modeNote(v) {
  const n = v.documents.filter((d) => !d.supersededBy && d.extraction && d.extraction.kind === 'cloud').length;
  return n
    ? `deterministic rules decide every status, link and comparison; the text of ${n} document(s) was extracted by Sarvam Document AI (an external cloud service, after explicit consent) and is marked "verify against the original"`
    : MODE_NOTE;
}

const cites = (ev) => (ev || []).map((e) => ({ document: e.docName, page: e.page, excerpt: e.excerpt || null }));
const citeText = (ev) => (ev && ev.length ? ev.map((e) => `${e.docName} p.${e.page}`).join(' vs ') : 'no document (required evidence is absent)');
const cell = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

function buildManifest(v, at) {
  const docs = new Map(v.documents.map((d) => [d.id, d]));
  const links = new Map(v.links.map((l) => [l.id, l]));
  const reqs = new Map(v.requirements.map((r) => [r.id, r]));
  return {
    kind: 'claimtrail.packet-manifest', version: 1, generatedAt: at, demoData: true,
    notice: 'This manifest is a local evidence index. Exporting it is NOT a submission and NOT an acknowledgement.',
    analysisMode: modeNote(v),
    case: { id: v.case.id, title: v.case.title, claimRef: v.case.claimRef, policyNo: v.case.policyNo, status: v.case.status, statusLabel: v.case.statusLabel, submissionProofOnFile: v.submissions.length > 0 },
    requirements: v.statuses.map((st) => {
      const r = reqs.get(st.reqId);
      const d = docs.get(st.docId);
      const l = links.get(st.linkId);
      return {
        id: r.id, label: r.label, category: r.category, required: r.required, status: st.status, explanation: st.explanation,
        evidence: d ? {
          docId: d.id, docName: d.name, page: st.page, excerpt: st.excerpt, sha256: d.sha256, confidence: st.confidence,
          decision: l ? l.decision : null, confirmedBy: l && l.decision === 'accepted' ? l.decidedBy : null,
          provenanceValid: !!(st.page >= 1 && st.page <= d.pages.length && st.excerpt),
        } : null,
      };
    }),
    documents: v.documents.filter((d) => !d.supersededBy).map((d) => ({
      id: d.id, name: d.name, detectedType: d.classification.type, typeConfidence: d.classification.confidence, sha256: d.sha256, size: d.size,
      pages: d.pages.length, readablePages: d.pages.filter((p) => p.readable).length,
      cloudExtraction: d.extraction && d.extraction.kind === 'cloud' ? { provider: 'Sarvam Document AI (external cloud service)', confidence: 'not supplied', note: 'Machine-read text; verify against the original document.' } : null,
      ocr: d.pages.some((p) => p.ocr && p.ocr.method === 'ocr') ? { pagesOcr: d.pages.filter((p) => p.ocr && p.ocr.method === 'ocr').length, lowConfidencePages: d.pages.filter((p) => p.ocr && (p.ocr.status === 'verify' || p.ocr.status === 'rejected_low_confidence')).length, note: 'Text read by local OCR (not an AI model); verify against the original image.' } : null,
      delivery: { status: d.delivery.status, ackRef: d.delivery.ackRef || null, proofSha256: d.delivery.proof ? d.delivery.proof.sha256 : null },
    })),
    replacedOrWithdrawn: v.documents.filter((d) => d.supersededBy).map((d) => ({ id: d.id, name: d.name, supersededBy: d.supersededBy })),
    openFindings: v.findings.filter((f) => f.status === 'open').map((f) => ({ key: f.key, code: f.code, severity: f.severity, title: f.title, citations: cites(f.evidence) })),
  };
}

function manifestMarkdown(m) {
  const L = [`# Packet manifest — ${m.case.id}`, '', `> ${m.notice}`, '', `Generated: ${m.generatedAt} · Mode: ${m.analysisMode} · DEMO DATA (fictional)`, '',
    `Case status: **${m.case.statusLabel}** · Submission proof on file: **${m.case.submissionProofOnFile ? 'yes' : 'no'}**`, '', '## Requirements and evidence', '',
    '| Requirement | Required | Status | Evidence | Source excerpt | SHA-256 (12) |', '|---|---|---|---|---|---|'];
  for (const r of m.requirements) {
    const e = r.evidence;
    L.push(`| ${cell(r.label)} | ${r.required ? 'yes' : 'no'} | ${r.status.replace('_', ' ')} | ${e ? cell(`${e.docName} p.${e.page}${e.confirmedBy ? ' (accepted by ' + e.confirmedBy + ')' : ' (suggested)'}`) : 'none'} | ${e ? cell(e.excerpt) : ''} | ${e ? e.sha256.slice(0, 12) : ''} |`);
  }
  L.push('', '## Documents', '', '| Id | Name | Detected type | Pages (readable) | Delivery | SHA-256 (12) |', '|---|---|---|---|---|---|');
  for (const d of m.documents) L.push(`| ${d.id} | ${cell(d.name)} | ${d.detectedType} | ${d.pages} (${d.readablePages}) | ${d.delivery.status.replace('_', ' ')}${d.delivery.ackRef ? ' ' + d.delivery.ackRef : ''} | ${d.sha256.slice(0, 12)} |`);
  L.push('', '## Open findings', '');
  if (!m.openFindings.length) L.push('None.');
  for (const f of m.openFindings) L.push(`- **${f.code}** (${f.severity}) ${f.title} — ${f.citations.length ? f.citations.map((c) => `${c.document} p.${c.page}`).join(' vs ') : 'required evidence absent'}`);
  return L.join('\n') + '\n';
}

const ACTION = {
  missing: 'Provide a document for this requirement.',
  unreadable: 'Provide a clearer, text-readable copy.',
  ambiguous: 'Choose which document satisfies this requirement.',
  needs_review: 'Confirm or reject the suggested match.',
};

function buildMissing(v, at) {
  return {
    kind: 'claimtrail.missing-items', version: 1, generatedAt: at, demoData: true,
    notice: 'A to-do list for the claimant. It is not a submission and not a decision on the claim.',
    items: v.statuses.filter((s) => s.status !== 'matched').map((s) => {
      const r = v.requirements.find((x) => x.id === s.reqId);
      return { reqId: s.reqId, label: s.label, required: r.required, status: s.status, why: s.explanation, action: ACTION[s.status] };
    }),
    findings: v.findings.filter((f) => f.status === 'open' && f.severity !== 'info' && f.code !== 'REQ_MISSING').map((f) => ({ code: f.code, severity: f.severity, title: f.title, citations: cites(f.evidence), detail: f.explanation })),
  };
}

function missingMarkdown(c) {
  const L = [`# Missing-items checklist`, '', `> ${c.notice}`, '', `Generated: ${c.generatedAt} · DEMO DATA (fictional)`, '', '## Requirements needing action', ''];
  if (!c.items.length) L.push('All requirements have linked, readable evidence.');
  for (const i of c.items) L.push(`- [ ] **${i.label}** (${i.required ? 'required' : 'optional'}, ${i.status.replace('_', ' ')}) — ${i.action} ${i.why}`);
  L.push('', '## Open items to check', '');
  if (!c.findings.length) L.push('None.');
  for (const f of c.findings) L.push(`- [ ] **${f.code}** ${f.title} — ${f.citations.length ? f.citations.map((x) => `${x.document} p.${x.page}`).join(' vs ') : 'n/a'}`);
  return L.join('\n') + '\n';
}

function buildReport(v, at, openBlocking) {
  const complete = v.case.status === 'intake_complete';
  const open = v.findings.filter((f) => f.status === 'open');
  const resolved = v.findings.filter((f) => f.status === 'resolved');
  const overrides = resolved.filter((f) => f.resolution.kind === 'reviewer_note');
  return {
    kind: 'claimtrail.intake-report', version: 1, generatedAt: at, demoData: true,
    notice: '"Intake checks complete" means configured document checks passed. It is not a coverage decision, a claim approval, a clinical judgement or a fraud determination.',
    analysisMode: modeNote(v),
    case: { id: v.case.id, claimRef: v.case.claimRef, status: v.case.status, statusLabel: v.case.statusLabel },
    outcome: {
      complete,
      openBlocking: openBlocking.length,
      explanation: complete
        ? `Configured intake checks passed${overrides.length ? ` with ${overrides.length} reviewer override(s) recorded below` : ''}.`
        : `Intake checks are NOT complete: ${openBlocking.length} blocking finding(s) remain open.`,
    },
    openFindings: open.map((f) => ({ code: f.code, severity: f.severity, title: f.title, explanation: f.explanation, citations: cites(f.evidence), firstSeenAt: f.firstSeenAt })),
    resolvedFindings: resolved.map((f) => ({ code: f.code, title: f.title, citations: cites(f.evidence), how: f.resolution.kind, by: f.resolution.by, note: f.resolution.note, at: f.resolution.at })),
    reviewerOverrides: overrides.map((f) => ({ code: f.code, title: f.title, by: f.resolution.by, note: f.resolution.note, at: f.resolution.at })),
    comparisons: v.comparisons.map((c) => ({ field: c.label, status: c.status, reasonCode: c.reasonCode, a: `${c.ref.docName} p.${c.ref.page ?? '-'}: ${c.ref.value ?? 'not found'}`, b: `${c.other.docName} p.${c.other.page ?? '-'}: ${c.other.value ?? 'not found'}` })),
    submissions: v.submissions.map((s) => ({ n: s.n, kind: s.kind, reference: s.reference, proofFile: s.proof.fileName, proofSha256: s.proof.sha256, at: s.at })),
    eventCount: v.events.length,
  };
}

function reportMarkdown(r) {
  const L = [`# Intake QA report — ${r.case.id}`, '', `> ${r.notice}`, '', `Generated: ${r.generatedAt} · Mode: ${r.analysisMode} · DEMO DATA (fictional)`, '',
    `**Case status:** ${r.case.statusLabel}`, `**Outcome:** ${r.outcome.explanation}`, '', '## Open findings', ''];
  if (!r.openFindings.length) L.push('None.');
  for (const f of r.openFindings) L.push(`- **${f.code}** (${f.severity}) ${f.title}`, `  - Source: ${f.citations.length ? f.citations.map((c) => `${c.document} p.${c.page}`).join(' vs ') : 'required evidence absent'}`, `  - Why: ${f.explanation}`);
  L.push('', '## Resolved findings', '');
  if (!r.resolvedFindings.length) L.push('None.');
  for (const f of r.resolvedFindings) L.push(`- **${f.code}** ${f.title} — ${f.how === 'reviewer_note' ? `reviewer override by ${f.by}: "${f.note}"` : 'resolved because the evidence changed'}`);
  L.push('', '## Cross-document comparisons', '', '| Field | Result | Code | Document A | Document B |', '|---|---|---|---|---|');
  for (const c of r.comparisons) L.push(`| ${cell(c.field)} | ${c.status.replace('_', ' ')} | ${c.reasonCode} | ${cell(c.a)} | ${cell(c.b)} |`);
  L.push('', '## Submission records', '');
  if (!r.submissions.length) L.push('None recorded.');
  for (const s of r.submissions) L.push(`- #${s.n} ${s.kind}: reference ${s.reference}, proof file ${s.proofFile} (SHA-256 ${s.proofSha256.slice(0, 12)}…) at ${s.at}`);
  return L.join('\n') + '\n';
}

module.exports = { buildManifest, manifestMarkdown, buildMissing, missingMarkdown, buildReport, reportMarkdown, citeText };
