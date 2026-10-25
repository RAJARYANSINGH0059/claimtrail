'use strict';
/** Deterministic message templates. Drafts are text for a human to review; nothing here can send anything. */
const FOOTER = [
  '',
  '---',
  'DRAFT prepared with ClaimTrail from a fixed template (no AI model used). Review and edit before use.',
  'ClaimTrail did not send this message and has no ability to send messages in demo mode.',
].join('\n');

const cite = (ev) => (ev && ev.length ? ev.map((e) => `${e.docName} p.${e.page}`).join(' vs ') : 'no document (required evidence is absent)');

function followUp(ctx) {
  const c = ctx.case;
  const lines = [`Subject: Follow-up on claim ${c.claimRef} — documents being prepared`, '', `Dear Claims Intake Team at ${c.insurer},`, '',
    `This is about claim ${c.claimRef} (policy ${c.policyNo}). I am assembling the documents you asked for.`, ''];
  const outstanding = ctx.statuses.filter((s) => ['missing', 'unreadable', 'ambiguous', 'needs_review'].includes(s.status));
  if (outstanding.length) {
    lines.push('Still outstanding on my side:');
    for (const s of outstanding) lines.push(`- ${s.label}: ${s.status.replace('_', ' ')}. ${s.explanation}`);
    lines.push('');
  } else lines.push('All requested items currently have linked evidence.', '');
  const review = ctx.openFindings.filter((f) => /^(DUP_|FIELD_)/.test(f.code) && f.severity !== 'info');
  if (review.length) {
    lines.push('Points I would like you to check (documentation differences, not conclusions):');
    for (const f of review) lines.push(`- ${f.title} [${f.code}] — ${cite(f.evidence)}`);
    lines.push('');
  }
  lines.push('I will send corrected or missing documents through your usual channel and keep the acknowledgement reference.', '', `Regards,`, c.claimant, FOOTER);
  return { subject: `Follow-up on claim ${c.claimRef} — documents being prepared`, body: lines.join('\n'), mode: 'template' };
}

function correctionRequest(ctx) {
  const c = ctx.case;
  const lines = [`Subject: Documents needed for claim ${c.claimRef}`, '', `Dear ${c.claimant},`, '',
    `Our intake check of claim ${c.claimRef} found items that need attention before intake checks can be completed.`,
    'This message asks for documentation only. It is not a coverage decision and does not say any document is false.', ''];
  ctx.openFindings.filter((f) => f.severity !== 'info').forEach((f, i) => {
    lines.push(`${i + 1}. ${f.title}  [${f.code}]`, `   Source: ${cite(f.evidence)}`, `   Detail: ${f.explanation}`);
  });
  lines.push('', 'Please send corrected or missing documents and record the resubmission with its proof reference.', '', 'Regards,', 'Intake reviewer (demo)', FOOTER);
  return { subject: `Documents needed for claim ${c.claimRef}`, body: lines.join('\n'), mode: 'template' };
}

module.exports = { followUp, correctionRequest, FOOTER };
