'use strict';
/**
 * AI adapter boundary.
 *
 * Current state (honest): ONLY the deterministic rules/template provider is implemented.
 * No external model, API key or network call is used anywhere in this build.
 * A live provider could be added behind classify / extractCandidates / draftWording, but its
 * output MUST pass the validators below, and deterministic code would still own state
 * transitions, comparisons, duplicate hashes, evidence links and permissions.
 */
const engine = require('./engine');
const reqs = require('./requirements');
const drafts = require('./drafts');

function validateClassification(c) {
  const errs = [];
  if (!c || typeof c !== 'object') errs.push('not an object');
  else {
    if (c.type !== 'unknown' && !engine.TYPES[c.type]) errs.push('unknown type');
    if (typeof c.confidence !== 'number' || c.confidence < 0 || c.confidence > 1) errs.push('confidence out of range');
    if (!Array.isArray(c.reasons) || c.reasons.some((r) => typeof r !== 'string')) errs.push('reasons must be strings');
    if (typeof c.mode !== 'string') errs.push('mode missing');
  }
  if (errs.length) throw new Error('Invalid classification: ' + errs.join(', '));
  return c;
}

function validateCandidates(list) {
  if (!Array.isArray(list)) throw new Error('Invalid candidates: not an array');
  for (const c of list) {
    if (!c || typeof c.label !== 'string' || c.label.length < 3 || c.label.length > 80) throw new Error('Invalid candidate label');
    if (c.category !== null && !engine.TYPES[c.category]) throw new Error('Invalid candidate category');
  }
  return list;
}

function validateDraft(d) {
  if (!d || typeof d.subject !== 'string' || typeof d.body !== 'string' || typeof d.mode !== 'string') throw new Error('Invalid draft');
  return d;
}

const providerInfo = ({ cloudDocuments = 0 } = {}) => ({
  mode: engine.MODE,
  live: cloudDocuments > 0,
  cloudDocuments,
  note: cloudDocuments > 0
    ? `Deterministic rules decide statuses, links, comparisons and permissions. The text of ${cloudDocuments} document(s) was extracted by Sarvam Document AI (an external cloud service) after explicit consent; those values are marked "verify against original".`
    : 'Deterministic rules and fixed templates only. No external model or API was used; uploaded content has not left this server. Images and PDFs may be read by local OCR software (Tesseract), which is not an AI model.',
});

const classify = (doc) => validateClassification(engine.classifyDocument(doc));
const extractCandidates = (text) => validateCandidates(reqs.extractRequirements(text));
const draftWording = (kind, ctx) => validateDraft(kind === 'correction_request' ? drafts.correctionRequest(ctx) : drafts.followUp(ctx));

module.exports = { classify, extractCandidates, draftWording, validateClassification, validateCandidates, validateDraft, providerInfo };
