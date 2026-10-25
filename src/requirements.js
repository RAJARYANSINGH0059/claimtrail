'use strict';
/** Deterministic candidate-requirement extraction from an insurer request letter (no AI model). */
const MODE = 'deterministic-rules';

const CATEGORY_RULES = [
  ['claim_form', /claim form/i],
  ['bill', /(?:hospital|final)\s+bill|itemi[sz]ed/i],
  ['discharge_summary', /discharge/i],
  ['lab_report', /diagnostic|laborator|\blab\b|pathology|radiolog|imaging/i],
  ['pharmacy_bill', /pharmacy|medicine/i],
  ['id_proof', /photo\s*id|identity|id proof/i],
  ['bank_proof', /cheque|bank/i],
];

const LIST_LINE = /^\s*(?:\d+[.)]|[-*•])\s+(.+?)\s*$/;

function extractRequirements(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = LIST_LINE.exec(line);
    if (!m) continue;
    const label = m[1].replace(/[.;]+$/, '').trim();
    if (label.length < 3) continue;
    const hit = CATEGORY_RULES.find(([, re]) => re.test(label));
    out.push({
      label: label.length > 80 ? label.slice(0, 79) + '…' : label,
      category: hit ? hit[0] : null,
      required: true,
      confidence: hit ? 0.8 : 0,
      source: line.trim(),
      mode: MODE,
      note: hit ? 'Category suggested by keyword rule; confirm before adding.' : 'No category rule matched; choose a category before adding.',
    });
  }
  return out;
}

module.exports = { MODE, extractRequirements, CATEGORY_RULES };
