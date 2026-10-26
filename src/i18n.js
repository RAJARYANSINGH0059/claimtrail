'use strict';
/**
 * First multilingual slice: English and Hindi guidance, built from FIXED phrase maps (deterministic, offline).
 * Languages actually implemented here: en, hi. (Sarvam Document AI itself supports 22 Indian languages plus
 * English for reading documents; that is a provider capability, not ClaimTrail UI support.)
 *
 * Rules enforced here and in tests:
 *  - the original English wording (requirement label, finding title, evidence excerpt) is ALWAYS returned next to
 *    the translation, never replaced;
 *  - canonical values (IDs, amounts, dates, names, file names, page numbers) are copied verbatim from the evidence,
 *    never translated or re-formatted (no Devanagari numerals);
 *  - this is explanatory help, not legal or coverage advice, and says so in both languages.
 */
const LANGS = { en: 'English', hi: 'हिन्दी (Hindi)' };

const NEXT = {
  draft: { en: () => 'Claimant: start preparing the packet', hi: () => 'दावेदार: पैकेट तैयार करना शुरू करें' },
  preparing_ready: { en: () => 'Claimant: mark the packet ready for review', hi: () => 'दावेदार: पैकेट को समीक्षा के लिए तैयार चिह्नित करें' },
  preparing_blocked: { en: (n) => `Claimant: resolve ${n} readiness blocker(s)`, hi: (n) => `दावेदार: ${n} बाधा(एँ) दूर करें` },
  ready_for_review: { en: () => 'Claimant: record the submission with proof', hi: () => 'दावेदार: प्रमाण के साथ सबमिशन दर्ज करें' },
  submitted: { en: () => 'Reviewer: start intake review', hi: () => 'समीक्षक: इनटेक समीक्षा शुरू करें' },
  review_open: { en: (n) => `Reviewer: work through ${n} open finding(s) or request corrections`, hi: (n) => `समीक्षक: ${n} खुले निष्कर्षों पर काम करें या सुधार का अनुरोध करें` },
  review_unconfirmed: { en: (n) => `Reviewer: confirm ${n} suggested match(es), then mark intake checks complete`, hi: (n) => `समीक्षक: ${n} सुझाए गए मिलान की पुष्टि करें, फिर इनटेक जाँच पूर्ण चिह्नित करें` },
  review_done: { en: () => 'Reviewer: mark intake checks complete', hi: () => 'समीक्षक: इनटेक जाँच पूर्ण चिह्नित करें' },
  action_required: { en: () => 'Claimant: provide corrected evidence, then record the resubmission with proof', hi: () => 'दावेदार: सही किया गया साक्ष्य दें, फिर प्रमाण के साथ पुनः सबमिशन दर्ज करें' },
  resubmitted_open: { en: (n) => `Reviewer: ${n} finding(s) still open; resolve them or request further corrections`, hi: (n) => `समीक्षक: ${n} निष्कर्ष अभी खुले हैं; उन्हें हल करें या और सुधार माँगें` },
  complete: { en: () => 'None: configured intake checks passed (this is not a coverage decision)', hi: () => 'कोई नहीं: कॉन्फ़िगर की गई इनटेक जाँचें पूरी हुईं (यह बीमा कवरेज का निर्णय नहीं है)' },
};

const STATUS = {
  matched: { en: 'Matched', hi: 'मिलान हुआ', hintEn: 'A document page was found for this requirement. Check it against the original.', hintHi: 'इस आवश्यकता के लिए दस्तावेज़ का पृष्ठ मिला है। मूल दस्तावेज़ से जाँच लें।' },
  missing: { en: 'Missing', hi: 'अनुपलब्ध', hintEn: 'No document was found for this requirement. Please add the right document.', hintHi: 'इस आवश्यकता के लिए कोई दस्तावेज़ नहीं मिला। कृपया सही दस्तावेज़ जोड़ें।' },
  unreadable: { en: 'Unreadable', hi: 'पढ़ने योग्य नहीं', hintEn: 'The page has too little readable text. Please upload a clearer copy.', hintHi: 'पृष्ठ में पढ़ने योग्य पाठ बहुत कम है। कृपया साफ़ प्रति अपलोड करें।' },
  ambiguous: { en: 'Ambiguous', hi: 'अस्पष्ट', hintEn: 'Several documents could satisfy this requirement. Please choose the right one.', hintHi: 'कई दस्तावेज़ इस आवश्यकता को पूरा कर सकते हैं। कृपया सही दस्तावेज़ चुनें।' },
  needs_review: { en: 'Needs review', hi: 'समीक्षा आवश्यक', hintEn: 'Confidence in this match is low. A person must accept or reject it.', hintHi: 'इस मिलान पर भरोसा कम है। किसी व्यक्ति को इसे स्वीकार या अस्वीकार करना होगा।' },
};

const FINDING = {
  REQ_MISSING: { en: 'A required document is missing.', hi: 'एक आवश्यक दस्तावेज़ उपलब्ध नहीं है।' },
  REQ_AMBIGUOUS: { en: 'More than one document could satisfy this requirement.', hi: 'एक से अधिक दस्तावेज़ इस आवश्यकता को पूरा कर सकते हैं।' },
  LINK_LOW_CONFIDENCE: { en: 'The suggested match is low-confidence and needs a person to decide.', hi: 'सुझाए गए मिलान पर भरोसा कम है; इस पर किसी व्यक्ति को निर्णय लेना होगा।' },
  DOC_PAGE_UNREADABLE: { en: 'A page has too little readable text. A clearer copy is needed.', hi: 'एक पृष्ठ में पढ़ने योग्य पाठ बहुत कम है। साफ़ प्रति चाहिए।' },
  DUP_EXACT: { en: 'Two uploaded files are identical copies.', hi: 'दो अपलोड की गई फ़ाइलें एक जैसी प्रतियाँ हैं।' },
  DUP_LIKELY: { en: 'Two documents look very similar and may be duplicates.', hi: 'दो दस्तावेज़ बहुत मिलते-जुलते हैं और डुप्लिकेट हो सकते हैं।' },
  FIELD_MISMATCH: { en: 'A value differs between two documents. This is a documentation difference to review, not a finding about the claimant.', hi: 'दो दस्तावेज़ों में एक मान अलग है। यह समीक्षा के लिए दस्तावेज़ी अंतर है; दावेदार के बारे में कोई निष्कर्ष नहीं है।' },
  FIELD_NEEDS_REVIEW: { en: 'A value is similar but not identical, or was machine-read. A person should check the original.', hi: 'एक मान मिलता-जुलता है पर एकदम समान नहीं है, या मशीन से पढ़ा गया है। कृपया मूल दस्तावेज़ जाँचें।' },
  FIELD_NOT_FOUND: { en: 'A value to compare was not found in one of the documents.', hi: 'तुलना के लिए एक मान किसी दस्तावेज़ में नहीं मिला।' },
  FIELD_NOT_COMPARABLE: { en: 'This value cannot be compared because a document has no readable text.', hi: 'इस मान की तुलना नहीं हो सकती क्योंकि एक दस्तावेज़ में पढ़ने योग्य पाठ नहीं है।' },
  PROVENANCE_MISSING: { en: 'A match has no valid source page, so it cannot be accepted.', hi: 'एक मिलान का कोई वैध स्रोत पृष्ठ नहीं है, इसलिए उसे स्वीकार नहीं किया जा सकता।' },
  DELIVERY_PROOF_MISSING: { en: 'A document is marked as sent but there is no proof on file.', hi: 'एक दस्तावेज़ "भेजा गया" दर्ज है पर कोई प्रमाण उपलब्ध नहीं है।' },
};

const DISCLAIMER = {
  en: 'Explanatory help only. It is not legal advice or an insurance decision. The original English wording is shown beside every line.',
  hi: 'यह केवल समझाने के लिए सहायता है। यह कानूनी सलाह या बीमा का निर्णय नहीं है। हर पंक्ति के साथ मूल अंग्रेज़ी पाठ दिखाया गया है।',
};

const isLang = (lang) => typeof lang === 'string' && Object.prototype.hasOwnProperty.call(LANGS, lang);
const pick = (map, lang) => (isLang(lang) && map[lang] !== undefined ? map[lang] : map.en);

/**
 * Build guidance. `info` = { next:{key,n}, statuses:[{reqId,label,status,docName?,page?}], findings:[...] }
 * All "original"/"cites" fields are copied verbatim from the case; only the surrounding sentences vary by language.
 */
function buildGuidance(lang, info) {
  if (!isLang(lang)) { const e = new Error('Unsupported language'); e.code = 'LANG_UNSUPPORTED'; throw e; }
  const nx = NEXT[info.next.key];
  return {
    lang, languages: Object.entries(LANGS).map(([id, label]) => ({ id, label })), mode: 'phrase-map', live: false,
    disclaimer: DISCLAIMER[lang], disclaimerEn: DISCLAIMER.en,
    nextAction: { text: nx[lang](info.next.n), original: nx.en(info.next.n) },
    requirements: info.statuses.map((s) => {
      const st = STATUS[s.status] || STATUS.needs_review;
      return {
        reqId: s.reqId, original: s.label, status: s.status, statusText: st[lang], statusOriginal: st.en,
        hint: lang === 'hi' ? st.hintHi : st.hintEn, hintOriginal: st.hintEn,
        source: s.docName ? { docName: s.docName, page: s.page } : null,
      };
    }),
    findings: info.findings.map((f) => ({
      key: f.key, code: f.code, blocking: !!f.blocking, text: pick(FINDING[f.code] || { en: f.title }, lang),
      original: f.title, originalExplanation: f.explanation,
      cites: (f.evidence || []).map((e) => ({ docName: e.docName, page: e.page, excerpt: e.excerpt })),
    })),
  };
}

/** Tokens whose canonical form must survive translation unchanged: IDs, numbers, amounts, dates. */
function canonicalTokens(text) {
  const set = new Set();
  for (const m of String(text).matchAll(/[A-Z]{2,}(?:-[A-Z0-9]+)+|\d[\d,./:-]*\d|\d/g)) set.add(m[0]);
  return [...set];
}
/** Returns { ok, missing[] }: ok only if every canonical token of the source appears verbatim in the translation. */
function checkInvariance(source, translated) {
  const missing = canonicalTokens(source).filter((t) => !String(translated).includes(t));
  return { ok: missing.length === 0 && !/[०-९]/.test(translated), missing };
}

module.exports = { LANGS, NEXT, STATUS, FINDING, DISCLAIMER, buildGuidance, canonicalTokens, checkInvariance };
