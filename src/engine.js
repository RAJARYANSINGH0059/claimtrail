'use strict';
/**
 * ClaimTrail deterministic rules engine.
 * Pure functions only: classification, field extraction, duplicate detection,
 * evidence-link suggestion, requirement status, cross-document comparison and
 * finding derivation. No I/O, no network, no randomness.
 */
const crypto = require('node:crypto');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const MODE = 'deterministic-rules';
const UNREADABLE_EXCERPT = '(no extractable text on this page)';
const MIN_READABLE_CHARS = 40;
const MIN_ALNUM_RATIO = 0.5;
const CONFIDENCE_ACCEPT = 0.75;
const LIKELY_DUP_JACCARD = 0.85;
const MIN_DUP_TOKENS = 20;

/* ---------- document types ---------- */
const TYPES = {
  claim_form: {
    label: 'Claim form',
    rules: [[/claim form/i, 2], [/amount claimed/i, 2], [/declaration/i, 1], [/policy (?:no|number)/i, 1], [/claim (?:ref|reference|id)/i, 1]],
    fileHint: /claim[_\- ]?form/i,
  },
  bill: {
    label: 'Hospital final bill',
    rules: [[/final bill/i, 2], [/bill no/i, 1], [/(?:grand total|total amount)/i, 1], [/(?:room|consultation|procedure) charges/i, 1], [/invoice/i, 1]],
    fileHint: /hospital[_\- ]?(?:final[_\- ]?)?bill|final[_\- ]?bill|invoice/i,
  },
  discharge_summary: {
    label: 'Discharge summary',
    rules: [[/discharge summary/i, 2], [/diagnosis/i, 1], [/condition at discharge/i, 1], [/advice on discharge/i, 1], [/treating doctor/i, 1]],
    fileHint: /discharge/i,
  },
  lab_report: {
    label: 'Diagnostic / lab report',
    rules: [[/(?:laboratory|pathology|diagnostic) report/i, 2], [/reference range/i, 2], [/test (?:name|result)/i, 1], [/specimen|sample collected/i, 1], [/radiology|imaging/i, 1]],
    fileHint: /lab|pathology|diagnostic|radiology/i,
  },
  pharmacy_bill: {
    label: 'Pharmacy bill',
    rules: [[/pharmacy/i, 2], [/medicine/i, 1], [/batch|expiry|exp /i, 1], [/tablet|capsule|syrup/i, 1], [/cash memo/i, 1]],
    fileHint: /pharmacy|medicine/i,
  },
  id_proof: {
    label: 'Photo ID',
    rules: [[/identity card|photo id/i, 2], [/date of birth|dob/i, 1], [/id (?:no|number)/i, 1], [/valid (?:till|upto|until)/i, 1]],
    fileHint: /id[_\- ]?proof|photo[_\- ]?id|identity/i,
  },
  bank_proof: {
    label: 'Bank proof',
    rules: [[/cancelled cheque/i, 3], [/ifsc/i, 2], [/account (?:no|number)/i, 1], [/account holder/i, 1], [/statement/i, 1]],
    fileHint: /bank|cheque|statement/i,
  },
};
const TYPE_ORDER = Object.keys(TYPES);
const typeLabel = (t) => (TYPES[t] ? TYPES[t].label : 'Unclassified');

/* ---------- reason codes ---------- */
const CODES = {
  REQ_MISSING: { severity: 'blocker', label: 'Required evidence missing' },
  REQ_AMBIGUOUS: { severity: 'review', label: 'Ambiguous evidence match' },
  LINK_LOW_CONFIDENCE: { severity: 'review', label: 'Low-confidence match needs confirmation' },
  DOC_PAGE_UNREADABLE: { severity: 'blocker', label: 'Unreadable / low-text page' },
  DUP_EXACT: { severity: 'review', label: 'Exact duplicate file' },
  DUP_LIKELY: { severity: 'review', label: 'Likely duplicate document' },
  FIELD_MISMATCH: { severity: 'blocker', label: 'Cross-document field mismatch' },
  FIELD_NEEDS_REVIEW: { severity: 'review', label: 'Cross-document field needs review' },
  FIELD_NOT_FOUND: { severity: 'info', label: 'Field not found for comparison' },
  FIELD_NOT_COMPARABLE: { severity: 'info', label: 'Field not comparable' },
  PROVENANCE_MISSING: { severity: 'blocker', label: 'Evidence link lacks a valid source reference' },
  DELIVERY_PROOF_MISSING: { severity: 'info', label: 'Delivery claimed without proof' },
};
const BLOCKING = new Set(['blocker', 'review']);
const isBlocking = (f) => f.status === 'open' && BLOCKING.has(f.severity);

/* ---------- text helpers ---------- */
function pageReadable(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length < MIN_READABLE_CHARS) return false;
  const alnum = (t.match(/[\p{L}\p{N}]/gu) || []).length;
  return alnum / t.length >= MIN_ALNUM_RATIO;
}
const docReadablePages = (doc) => doc.pages.filter((p) => pageReadable(p.text));
const docReadable = (doc) => docReadablePages(doc).length > 0;
const clip = (s, n = 160) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

function scoreText(text, type) {
  let score = 0;
  for (const [re, w] of TYPES[type].rules) if (re.test(text)) score += w;
  return score;
}

/* ---------- classification ---------- */
function classifyDocument(doc) {
  const pages = docReadablePages(doc);
  if (pages.length === 0) {
    const hinted = TYPE_ORDER.find((t) => TYPES[t].fileHint.test(doc.name));
    return hinted
      ? { type: hinted, confidence: 0.4, readable: false, mode: MODE, reasons: [`No readable text; filename hint only (${hinted})`] }
      : { type: 'unknown', confidence: 0, readable: false, mode: MODE, reasons: ['No readable text and no filename hint'] };
  }
  const text = pages.map((p) => p.text).join('\n');
  const ranked = TYPE_ORDER.map((type) => {
    const reasons = TYPES[type].rules.filter(([re]) => re.test(text)).map(([re]) => `text matches /${re.source}/`);
    return { type, score: scoreText(text, type), reasons };
  }).sort((a, b) => b.score - a.score);
  const [best, second] = ranked;
  if (best.score === 0) return { type: 'unknown', confidence: 0, readable: true, mode: MODE, reasons: ['No classification rule matched'] };
  let confidence = Math.min(1, best.score / 4);
  const reasons = best.reasons.slice();
  if (second.score > 0 && second.score >= best.score * 0.75) {
    confidence = Math.min(confidence, 0.6);
    reasons.push(`competing type ${second.type} scored ${second.score} vs ${best.score}`);
  }
  return { type: best.type, confidence: Math.round(confidence * 100) / 100, readable: true, mode: MODE, reasons };
}

/* ---------- field extraction ---------- */
const AMT = '(?:₹|rs\\.?|inr)?\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)';
const FIELD_RULES = {
  patientName: [/(?:patient|insured|claimant|holder)\s*name\s*[:\-]\s*(.+)$/i, /^\s*name\s*[:\-]\s*(.+)$/i],
  policyNo: [/policy\s*(?:no\.?|number)\s*[:\-]\s*([A-Z0-9\-]+)/i],
  claimRef: [/claim\s*(?:ref(?:erence)?|id|no\.?)\s*[:\-]\s*([A-Z0-9\-]+)/i],
  admitDate: [/(?:date of admission|admission date|admitted on)\s*[:\-]\s*([0-9][0-9\/\-.]*)/i],
  dischargeDate: [/(?:date of discharge|discharge date|discharged on)\s*[:\-]\s*([0-9][0-9\/\-.]*)/i],
  billTotal: [new RegExp('(?:grand total|total amount|net payable)\\s*[:\\-]?\\s*' + AMT, 'i')],
  claimedAmount: [new RegExp('amount claimed\\s*[:\\-]?\\s*' + AMT, 'i')],
};

function extractFields(doc) {
  const out = {};
  for (const page of doc.pages) {
    if (!pageReadable(page.text)) continue;
    for (const line of String(page.text).split(/\r?\n/)) {
      for (const [field, rules] of Object.entries(FIELD_RULES)) {
        if (out[field]) continue;
        for (const re of rules) {
          const m = re.exec(line);
          if (m) {
            out[field] = { value: m[1].trim().replace(/[.,;]+$/, ''), page: page.n, excerpt: clip(line) };
            if (page.ocr && page.ocr.method === 'ocr' && page.ocr.status === 'verify') out[field].ocrVerify = true;
            break;
          }
        }
      }
    }
  }
  return out;
}

const TITLES = /\b(mr|mrs|ms|shri|smt|dr)\b\.?/gi;
const nameTokens = (s) => String(s).toLowerCase().replace(TITLES, ' ').replace(/[^\p{L}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
function normDate(s) {
  const t = String(s).trim().replace(/[.\-/]+$/, '');
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  let y, mo, d;
  if (m) [y, mo, d] = [m[1], m[2], m[3]];
  else if ((m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/.exec(t))) [d, mo, y] = [m[1].padStart(2, '0'), m[2].padStart(2, '0'), m[3]];
  else return null;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return null;
  return `${y}-${mo}-${d}`;
}
const normAmount = (s) => { const n = Number(String(s).replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
const normId = (s) => String(s).toUpperCase().replace(/\s+/g, '');

function compareValues(kind, a, b) {
  if (kind === 'name') {
    const ta = nameTokens(a), tb = nameTokens(b);
    if (!ta.length || !tb.length) return 'not_comparable';
    if (ta.join(' ') === tb.join(' ')) return 'match';
    if (ta[ta.length - 1] === tb[tb.length - 1]) {
      const fa = ta[0], fb = tb[0];
      if (fa[0] === fb[0] && (fa.length === 1 || fb.length === 1)) return 'needs_review';
    }
    const [small, big] = ta.length <= tb.length ? [new Set(ta), new Set(tb)] : [new Set(tb), new Set(ta)];
    if (small.size >= 2 && [...small].every((t) => big.has(t))) return 'needs_review';
    return 'mismatch';
  }
  if (kind === 'date') { const x = normDate(a), y = normDate(b); return x && y ? (x === y ? 'match' : 'mismatch') : 'not_comparable'; }
  if (kind === 'amount') { const x = normAmount(a), y = normAmount(b); return x !== null && y !== null ? (Math.abs(x - y) < 0.005 ? 'match' : 'mismatch') : 'not_comparable'; }
  return normId(a) === normId(b) ? 'match' : 'mismatch';
}

/* ---------- duplicates ---------- */
function tokenSet(doc) {
  const text = doc.pages.map((p) => p.text).join(' ').toLowerCase();
  return new Set(text.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2));
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}
function detectDuplicates(docs) {
  const active = docs.filter((d) => !d.supersededBy);
  const out = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i], b = active[j];
      if (a.sha256 && a.sha256 === b.sha256) { out.push({ a: a.id, b: b.id, kind: 'exact', score: 1 }); continue; }
      const ta = tokenSet(a), tb = tokenSet(b);
      if (ta.size < MIN_DUP_TOKENS || tb.size < MIN_DUP_TOKENS) continue;
      const score = jaccard(ta, tb);
      if (score >= LIKELY_DUP_JACCARD) out.push({ a: a.id, b: b.id, kind: 'likely', score: Math.round(score * 1000) / 1000 });
    }
  }
  return out;
}

/* ---------- evidence links ---------- */
function bestPage(doc, type) {
  let best = null;
  for (const p of doc.pages) {
    if (!pageReadable(p.text)) continue;
    const score = scoreText(p.text, type);
    if (!best || score > best.score) best = { page: p.n, score, text: p.text };
  }
  if (!best) return null;
  const lines = best.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hit = lines.find((l) => TYPES[type].rules.some(([re]) => re.test(l))) || lines[0] || '';
  return { page: best.page, excerpt: clip(hit) };
}

function suggestLinks(requirements, docs) {
  const out = [];
  for (const req of requirements) {
    for (const doc of docs) {
      if (doc.supersededBy) continue;
      const c = doc.classification;
      if (!c || c.type !== req.category) continue;
      if (!c.readable) { out.push({ reqId: req.id, docId: doc.id, page: 1, excerpt: UNREADABLE_EXCERPT, confidence: c.confidence, reason: c.reasons.join('; ') }); continue; }
      const bp = bestPage(doc, req.category) || { page: 1, excerpt: clip(doc.pages[0].text) };
      out.push({ reqId: req.id, docId: doc.id, page: bp.page, excerpt: bp.excerpt, confidence: c.confidence, reason: c.reasons.join('; ') });
    }
  }
  return out;
}

function validateLink(link, docs) {
  const problems = [];
  const doc = docs.find((d) => d.id === link.docId);
  if (!doc) problems.push('referenced document does not exist');
  else {
    if (!Number.isInteger(link.page) || link.page < 1 || link.page > doc.pages.length) problems.push('page is outside the document');
  }
  if (typeof link.excerpt !== 'string' || !link.excerpt.trim()) problems.push('no source excerpt recorded');
  return { valid: problems.length === 0, problems };
}

const linkActive = (l) => l.decision !== 'rejected' && l.decision !== 'superseded';

/* ---------- requirement status ---------- */
function clusterMap(dups) {
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (const d of dups) { for (const id of [d.a, d.b]) if (!parent.has(id)) parent.set(id, id); parent.set(find(d.a), find(d.b)); }
  const m = new Map();
  for (const id of parent.keys()) m.set(id, find(id));
  return m;
}

function deriveStatuses({ requirements, documents, links, dups }) {
  const active = documents.filter((d) => !d.supersededBy);
  const byId = new Map(active.map((d) => [d.id, d]));
  const order = new Map(active.map((d, i) => [d.id, i]));
  const clusters = clusterMap(dups);
  const pct = (c) => `${Math.round(c * 100)}%`;
  return requirements.map((req) => {
    const cand = links.filter((l) => l.reqId === req.id && linkActive(l) && byId.has(l.docId));
    const rejected = links.some((l) => l.reqId === req.id && l.decision === 'rejected');
    const base = { reqId: req.id, status: 'missing', linkId: null, docId: null, page: null, excerpt: null, confidence: null, candidates: cand.length, duplicate: false, confirmed: false, explanation: '' };
    if (!cand.length) {
      return { ...base, explanation: `No active document is classified as "${typeLabel(req.category)}".${rejected ? ' Suggested matches were rejected.' : ''}` };
    }
    const readableLink = (l) => pageReadable(byId.get(l.docId).pages[l.page - 1] ? byId.get(l.docId).pages[l.page - 1].text : '');
    const sorted = cand.slice().sort((x, y) =>
      (y.decision === 'accepted') - (x.decision === 'accepted') ||
      readableLink(y) - readableLink(x) ||
      y.confidence - x.confidence ||
      order.get(x.docId) - order.get(y.docId));
    const chosen = sorted[0];
    const doc = byId.get(chosen.docId);
    const confirmed = chosen.decision === 'accepted';
    const dup = dups.some((d) => d.a === chosen.docId || d.b === chosen.docId);
    const common = { ...base, linkId: chosen.id, docId: chosen.docId, page: chosen.page, excerpt: chosen.excerpt, confidence: chosen.confidence, duplicate: dup, confirmed };
    if (!readableLink(chosen)) {
      return { ...common, status: 'unreadable', explanation: `${doc.name} p.${chosen.page} has too little extractable text; a clearer copy is needed.` };
    }
    if (!confirmed) {
      const rivals = sorted.slice(1).filter((l) => readableLink(l) &&
        (clusters.get(l.docId) || l.docId) !== (clusters.get(chosen.docId) || chosen.docId) &&
        chosen.confidence - l.confidence <= 0.15);
      if (rivals.length) {
        const names = [chosen, ...rivals].map((l) => byId.get(l.docId).name).join(', ');
        return { ...common, status: 'ambiguous', explanation: `Several different documents could satisfy this: ${names}. Select the right one.` };
      }
      if (chosen.confidence < CONFIDENCE_ACCEPT) {
        return { ...common, status: 'needs_review', explanation: `Low-confidence match (${pct(chosen.confidence)}) to ${doc.name} p.${chosen.page}; a person must accept or reject it.` };
      }
    }
    return { ...common, status: 'matched', explanation: `Matched to ${doc.name} p.${chosen.page} (${typeLabel(doc.classification.type)}, ${pct(chosen.confidence)}, ${confirmed ? 'accepted by ' + (chosen.decidedBy || 'a person') : 'auto-suggested'}).` };
  });
}

/* ---------- cross-document comparison ---------- */
const COMPARISONS = [
  { field: 'patientName', label: 'Patient / insured name', ref: 'claim_form', others: ['bill', 'discharge_summary', 'pharmacy_bill', 'id_proof'], kind: 'name' },
  { field: 'policyNo', label: 'Policy number', ref: 'claim_form', others: ['bill'], kind: 'id' },
  { field: 'claimRef', label: 'Claim reference', ref: 'claim_form', others: ['bill'], kind: 'id' },
  { field: 'admitDate', label: 'Admission date', ref: 'bill', others: ['discharge_summary'], kind: 'date' },
  { field: 'dischargeDate', label: 'Discharge date', ref: 'bill', others: ['discharge_summary'], kind: 'date' },
  { field: 'amount', label: 'Claimed amount vs bill total', ref: 'claim_form', refField: 'claimedAmount', others: ['bill'], otherField: 'billTotal', kind: 'amount' },
];
const CMP_REASON = { match: 'FIELD_MATCH', mismatch: 'FIELD_MISMATCH', needs_review: 'FIELD_NEEDS_REVIEW', not_found: 'FIELD_NOT_FOUND', not_comparable: 'FIELD_NOT_COMPARABLE' };

function runComparisons({ requirements, documents, statuses }) {
  const active = documents.filter((d) => !d.supersededBy);
  const byId = new Map(active.map((d) => [d.id, d]));
  const primary = (type) => {
    const req = requirements.find((r) => r.category === type);
    const st = req && statuses.find((s) => s.reqId === req.id);
    return st && st.docId && byId.has(st.docId) ? byId.get(st.docId) : null;
  };
  const rows = [];
  for (const spec of COMPARISONS) {
    const refDoc = primary(spec.ref);
    if (!refDoc) continue;
    for (const otherType of spec.others) {
      const otherDoc = primary(otherType);
      if (!otherDoc || otherDoc.id === refDoc.id) continue;
      const rv = (refDoc.fields || {})[spec.refField || spec.field];
      const ov = (otherDoc.fields || {})[spec.otherField || spec.field];
      const side = (doc, v) => ({ docId: doc.id, docName: doc.name, page: v ? v.page : null, value: v ? v.value : null, excerpt: v ? v.excerpt : null });
      let status, why;
      if (!docReadable(refDoc) || !docReadable(otherDoc)) {
        const bad = !docReadable(refDoc) ? refDoc : otherDoc;
        status = 'not_comparable'; why = `${bad.name} has no readable text, so this field cannot be compared.`;
      } else if (!rv || !ov) {
        status = 'not_found';
        const missingIn = [!rv && refDoc, !ov && otherDoc].filter(Boolean).map((d) => d.name).join(' and ');
        why = `${spec.label} was not found in ${missingIn}.`;
      } else {
        status = compareValues(spec.kind, rv.value, ov.value);
        const ocrNote = rv.ocrVerify || ov.ocrVerify;
        if (ocrNote && status === 'mismatch') status = 'needs_review';
        why = status === 'match' ? `${spec.label} agrees across both documents.`
          : status === 'needs_review' && ocrNote ? `${spec.label} differs ("${rv.value}" vs "${ov.value}") but at least one value was read by OCR with low confidence; check the original image before treating it as a real difference.`
          : status === 'needs_review' ? `${spec.label} is similar but not identical ("${rv.value}" vs "${ov.value}"); a person should confirm they refer to the same person or value.`
          : status === 'mismatch' ? `${spec.label} differs ("${rv.value}" vs "${ov.value}"). This is a documentation inconsistency for review, not a determination of fraud or a coverage decision.`
          : `${spec.label} could not be parsed for comparison.`;
      }
      rows.push({
        id: `${spec.field}|${refDoc.id}|${otherDoc.id}`, field: spec.field, label: spec.label, status, reasonCode: CMP_REASON[status],
        ref: side(refDoc, rv), other: side(otherDoc, ov), explanation: why,
      });
    }
  }
  return rows;
}

/* ---------- findings ---------- */
function mkFinding(code, subject, title, explanation, evidence, extra = {}) {
  const fingerprint = sha256(JSON.stringify({ code, evidence: evidence.map((e) => [e.docId, e.page, e.excerpt]), extra: extra.values || null }));
  return { key: `${code}|${subject}`, code, severity: CODES[code].severity, title, explanation, evidence, fingerprint, ...(extra.reqIds ? { reqIds: extra.reqIds } : {}) };
}

function deriveFindings({ requirements, documents, links, dups, statuses, comparisons }) {
  const out = [];
  const active = documents.filter((d) => !d.supersededBy);
  const byId = new Map(active.map((d) => [d.id, d]));
  const ev = (doc, page, excerpt) => ({ docId: doc.id, docName: doc.name, page, excerpt: excerpt || null });

  for (const req of requirements) {
    const st = statuses.find((s) => s.reqId === req.id);
    if (st.status === 'missing' && req.required) {
      out.push(mkFinding('REQ_MISSING', req.id, `Missing: ${req.label}`, `${st.explanation} The insurer's request requires this evidence and none is linked.`, [], { reqIds: [req.id] }));
    } else if (st.status === 'ambiguous') {
      const d = byId.get(st.docId);
      out.push(mkFinding('REQ_AMBIGUOUS', req.id, `Ambiguous evidence: ${req.label}`, st.explanation, [ev(d, st.page, st.excerpt)], { reqIds: [req.id] }));
    } else if (st.status === 'needs_review') {
      const d = byId.get(st.docId);
      out.push(mkFinding('LINK_LOW_CONFIDENCE', `${req.id}|${st.docId}`, `Confirm match: ${req.label}`, st.explanation, [ev(d, st.page, st.excerpt)], { reqIds: [req.id] }));
    }
  }
  for (const doc of active) {
    for (const p of doc.pages) {
      if (pageReadable(p.text)) continue;
      const affected = requirements.filter((r) => statuses.some((s) => s.reqId === r.id && s.docId === doc.id)).map((r) => r.label);
      out.push(mkFinding('DOC_PAGE_UNREADABLE', `${doc.id}#${p.n}`, `Unreadable page: ${doc.name} p.${p.n}`,
        `Too little extractable text on ${doc.name} p.${p.n}${affected.length ? ` (affects: ${affected.join(', ')})` : ''}. A clearer or text-readable copy is needed; no OCR is used in offline mode.`,
        [ev(doc, p.n, UNREADABLE_EXCERPT)]));
    }
  }
  for (const d of dups) {
    const a = byId.get(d.a), b = byId.get(d.b);
    const code = d.kind === 'exact' ? 'DUP_EXACT' : 'DUP_LIKELY';
    out.push(mkFinding(code, [d.a, d.b].sort().join('+'),
      d.kind === 'exact' ? `Exact duplicate: ${a.name} and ${b.name}` : `Possible duplicate: ${a.name} and ${b.name}`,
      d.kind === 'exact' ? `${a.name} and ${b.name} have identical file hashes.` : `${a.name} and ${b.name} share ${Math.round(d.score * 100)}% of their text tokens. They may be copies of the same document; a person should confirm. This is not a finding of misconduct.`,
      [ev(a, 1, clip(a.pages[0].text, 100)), ev(b, 1, clip(b.pages[0].text, 100))], { values: [d.kind, d.score] }));
  }
  for (const c of comparisons) {
    if (c.status === 'match') continue;
    const code = c.reasonCode;
    const titleBy = { mismatch: 'Mismatch', needs_review: 'Needs review', not_found: 'Not found', not_comparable: 'Not comparable' };
    // A field that was not found or not readable is cited at page 1 of the document (where the check looked), never with a null page.
    const cite = (x) => ({ docId: x.docId, docName: x.docName, page: x.page || 1, excerpt: x.excerpt || (x.value === null ? '(field not found on this document)' : null) });
    out.push(mkFinding(code, c.id, `${titleBy[c.status]}: ${c.label} (${c.ref.docName} vs ${c.other.docName})`, c.explanation,
      [cite(c.ref), cite(c.other)],
      { values: [c.ref.value, c.other.value] }));
  }
  for (const l of links) {
    if (!linkActive(l) || !byId.has(l.docId)) continue;
    const v = validateLink(l, documents);
    if (!v.valid) out.push(mkFinding('PROVENANCE_MISSING', l.id, `Evidence link ${l.id} lacks a valid source`, `Problems: ${v.problems.join('; ')}.`, [{ docId: l.docId, docName: byId.get(l.docId).name, page: l.page, excerpt: l.excerpt || null }]));
  }
  for (const doc of active) {
    if (doc.delivery && doc.delivery.status === 'sent_claimed') {
      out.push(mkFinding('DELIVERY_PROOF_MISSING', doc.id, `No delivery proof: ${doc.name}`, `${doc.name} is marked "claimed sent" but no acknowledgement reference and proof are recorded. It is not counted as acknowledged.`, [ev(doc, 1, null)]));
    }
  }
  return out;
}

/* ---------- readiness (claimant side) ---------- */
function readiness({ requirements, statuses, documents, links }) {
  const blockers = [], warnings = [];
  for (const req of requirements) {
    const st = statuses.find((s) => s.reqId === req.id);
    if (st.status === 'missing' && req.required) blockers.push(`Missing required evidence: ${req.label}`);
    else if (['unreadable', 'ambiguous', 'needs_review'].includes(st.status)) warnings.push(`${req.label}: ${st.status.replace('_', ' ')}`);
  }
  for (const l of links) {
    if (linkActive(l) && !validateLink(l, documents).valid) blockers.push(`Evidence link ${l.id} has no valid source reference`);
  }
  return { ready: blockers.length === 0, blockers, warnings };
}

/** Full pure analysis over a state-like object. */
function analyze(state) {
  const dups = detectDuplicates(state.documents);
  const base = { requirements: state.requirements, documents: state.documents, links: state.links, dups };
  const statuses = deriveStatuses(base);
  const comparisons = runComparisons({ ...base, statuses });
  const findings = deriveFindings({ ...base, statuses, comparisons });
  const ready = readiness({ ...base, statuses });
  return { dups, statuses, comparisons, findings, readiness: ready, clusters: [...clusterMap(dups).entries()] };
}

module.exports = {
  sha256, TYPES, TYPE_ORDER, typeLabel, CODES, BLOCKING, isBlocking, MODE, UNREADABLE_EXCERPT, CONFIDENCE_ACCEPT,
  pageReadable, docReadable, classifyDocument, extractFields, compareValues, nameTokens, normDate, normAmount,
  tokenSet, jaccard, detectDuplicates, suggestLinks, validateLink, linkActive, deriveStatuses, runComparisons,
  deriveFindings, readiness, analyze, COMPARISONS, clip,
};
