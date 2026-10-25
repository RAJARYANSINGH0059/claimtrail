'use strict';
/**
 * Deterministic synthetic fixtures. Every person, provider, ID and amount here is FICTIONAL.
 * seed(store) replays ordinary store operations with a stepping clock, so a reset always yields
 * the same case, documents, hashes, findings and audit trail (timestamps are re-based to "now").
 */
const engine = require('./engine');

const VERSION = 1;

const CASE = {
  id: 'CLM-DEMO-0001',
  title: 'Appendectomy reimbursement (synthetic)',
  claimant: 'Aarav Mehta',
  insurer: 'Example Mutual Health (fictional)',
  policyNo: 'POL-DEMO-48213',
  claimRef: 'CLM-DEMO-0001',
};

const REQUEST_LETTER = [
  'EXAMPLE MUTUAL HEALTH (FICTIONAL) — DOCUMENT REQUEST',
  'Claim Reference: CLM-DEMO-0001',
  'Please provide the following to process your reimbursement claim:',
  '1. Duly filled and signed claim form',
  '2. Hospital final bill with itemised charges',
  '3. Discharge summary from the treating doctor',
  '4. Diagnostic / laboratory reports supporting the treatment',
  '5. Pharmacy bills for medicines purchased',
  '6. Photo ID of the insured patient',
  '7. Cancelled cheque or bank proof for reimbursement',
  '(Synthetic demo letter. Not from a real insurer.)',
].join('\n');

const CLAIM_FORM = (amount, tag) => [
  `EXAMPLE MUTUAL HEALTH (FICTIONAL) — CLAIM FORM${tag}`,
  'Claim Reference: CLM-DEMO-0001',
  'Policy No: POL-DEMO-48213',
  'Patient Name: Aarav Mehta',
  'Date of Admission: 2026-09-02',
  'Date of Discharge: 2026-09-05',
  `Amount Claimed: ₹ ${amount}`,
  'Declaration: I declare that the information given is true. (synthetic demo document)',
].join('\n');

const BILL_P1 = [
  'RIVERSIDE DEMO HOSPITAL (FICTIONAL) — FINAL BILL',
  'Bill No: RDH-BILL-77120',
  'Claim Reference: CLM-DEMO-0001',
  'Policy No: POL-DEMO-48213',
  'Patient Name: Aarav Mehta',
  'Date of Admission: 2026-09-02',
  'Date of Discharge: 2026-09-05',
  'Room charges: ₹ 28,000',
  'Procedure charges: ₹ 82,500',
  'Consultation charges: ₹ 12,000',
].join('\n');
const BILL_P2 = [
  'Consumables and nursing: ₹ 20,000',
  'Grand Total: ₹ 1,42,500',
  'Invoice issued by the hospital billing desk. (synthetic demo document)',
].join('\n');

const DISCHARGE = [
  'RIVERSIDE DEMO HOSPITAL (FICTIONAL) — DISCHARGE SUMMARY',
  'Patient Name: Aarav Mehta',
  'Date of Admission: 2026-09-02',
  'Date of Discharge: 2026-09-05',
  'Diagnosis: Acute appendicitis (synthetic demo entry)',
  'Procedure: Laparoscopic appendectomy (synthetic demo entry)',
  'Condition at discharge: Stable',
  'Advice on discharge: Rest, light diet, follow-up in 7 days.',
  'Treating doctor: Dr. Demo Surgeon (fictional)',
].join('\n');

const BANK = [
  'CANCELLED CHEQUE — BANK PROOF (SYNTHETIC)',
  'Account Holder: Aarav Mehta',
  'Account Number: XXXXXX0000 (masked, fictional)',
  'IFSC: DEMO0001234',
].join('\n');

const PHOTO_ID = (name) => [
  'PHOTO ID — IDENTITY CARD (SYNTHETIC SAMPLE)',
  `Name: ${name}`,
  'Date of Birth: 1994-03-12',
  'ID Number: DEMO-ID-0001',
  'Valid till: 2031-12-31',
].join('\n');

const LAB = [
  'RIVERSIDE DEMO LABORATORY (FICTIONAL) — DIAGNOSTIC REPORT',
  'Patient Name: Aarav Mehta',
  'Specimen: Blood sample collected 2026-09-02',
  'Test Name | Test Result | Reference Range',
  'Hemoglobin | 13.9 g/dL | 13.0 - 17.0 g/dL',
  'Total leukocyte count | 12,400 /uL | 4,000 - 11,000 /uL',
  '(synthetic demo values)',
].join('\n');

const PHARMACY = [
  'SAMPLE CITY PHARMACY (FICTIONAL) — CASH MEMO',
  'Patient Name: Aarav Mehta',
  'Medicine: Amoxicillin capsule, batch DEMO-B1, exp 2027-06 — ₹ 640',
  'Medicine: Paracetamol tablet, batch DEMO-B2, exp 2027-08 — ₹ 210',
  'Medicine: ORS syrup, batch DEMO-B3, exp 2027-03 — ₹ 150',
  'Total amount: ₹ 1,000',
].join('\n');

/** Seed packet: text documents as page arrays. */
const SEED_DOCS = [
  { name: 'claim_form.txt', pages: [CLAIM_FORM('1,24,500', '')] },
  { name: 'hospital_final_bill.txt', pages: [BILL_P1, BILL_P2] },
  { name: 'discharge_summary.txt', pages: [DISCHARGE] },
  { name: 'discharge_summary_copy.txt', pages: [DISCHARGE + '\nPatient copy'] },
  { name: 'pharmacy_bill_scan.png', mime: 'image/png', size: 184320, pages: [''], hashSeed: 'fixture:pharmacy_bill_scan.png' },
  { name: 'cancelled_cheque.txt', pages: [BANK] },
  { name: 'photo_id.txt', pages: [PHOTO_ID('Aarav K Mehta')] },
];

/** Optional sample documents a judge can add (they are the "corrected / missing evidence"). */
const SAMPLES = [
  { id: 'S-LAB', name: 'lab_report.txt', title: 'Diagnostic / lab report', note: 'Supplies the missing required report.', replacesName: null, pages: [LAB] },
  { id: 'S-PHARM', name: 'pharmacy_bill_readable.txt', title: 'Readable pharmacy bill', note: 'Replaces the unreadable scan and shows the re-upload diff.', replacesName: 'pharmacy_bill_scan.png', pages: [PHARMACY] },
  { id: 'S-CLAIM-FIX', name: 'claim_form_corrected.txt', title: 'Corrected claim form', note: 'Fixes the claimed-amount mismatch (this is the case that stays open until someone acts).', replacesName: 'claim_form.txt', pages: [CLAIM_FORM('1,42,500', ' (CORRECTED)')] },
  { id: 'S-ID-FIX', name: 'photo_id_corrected.txt', title: 'Photo ID with matching full name', note: 'Resolves the name-format difference.', replacesName: 'photo_id.txt', pages: [PHOTO_ID('Aarav Mehta')] },
];

const SYNTHETIC_RECEIPT = (kind, ref) => [
  `SYNTHETIC ${kind} RECEIPT — FICTIONAL, GENERATED FOR THE DEMO`,
  `Reference: ${ref}`,
  'This receipt does not come from any real insurer or system.',
].join('\n');

/** Static queue filler rows. Invented for layout only; they are not real or measured. */
const SYNTH_QUEUE = [
  { id: 'CLM-SYN-1001', claimant: 'Synthetic Claimant A', status: 'intake_review', openBlockers: 2, nextAction: 'Reviewer: review open findings', ageDays: 3, firstPassComplete: false, requestCount: 2, reopened: false, triageHours: 6 },
  { id: 'CLM-SYN-1002', claimant: 'Synthetic Claimant B', status: 'action_required', openBlockers: 1, nextAction: 'Claimant: provide corrected evidence', ageDays: 5, firstPassComplete: false, requestCount: 1, reopened: false, triageHours: 9 },
  { id: 'CLM-SYN-1003', claimant: 'Synthetic Claimant C', status: 'resubmitted', openBlockers: 0, nextAction: 'Reviewer: mark intake checks complete', ageDays: 0, firstPassComplete: false, requestCount: 2, reopened: true, triageHours: 4 },
  { id: 'CLM-SYN-1004', claimant: 'Synthetic Claimant D', status: 'intake_complete', openBlockers: 0, nextAction: 'None', ageDays: 0, firstPassComplete: true, requestCount: 0, reopened: false, triageHours: 2 },
  { id: 'CLM-SYN-1005', claimant: 'Synthetic Claimant E', status: 'intake_complete', openBlockers: 0, nextAction: 'None', ageDays: 0, firstPassComplete: true, requestCount: 0, reopened: false, triageHours: 3 },
  { id: 'CLM-SYN-1006', claimant: 'Synthetic Claimant F', status: 'submitted', openBlockers: 0, nextAction: 'Reviewer: start intake review', ageDays: 1, firstPassComplete: false, requestCount: 0, reopened: false, triageHours: 12 },
];

const emptyState = () => ({
  version: VERSION,
  case: { ...CASE, status: 'preparing', requestLetter: REQUEST_LETTER, lastEvidenceChangeSeq: 0, actionRequiredSeq: 0 },
  requirements: [],
  documents: [],
  links: [],
  ledger: {},
  events: [],
  drafts: [],
  submissions: [],
  lastCheck: null,
  counters: { req: 0, doc: 0, draft: 0 },
});

/** Replays the seed through the store's own operations (claimant role, status "preparing"). */
function seed(store) {
  const { extractRequirements } = require('./requirements');
  store._emit('case_created', 'system', `Synthetic case ${CASE.id} created from fixture`, { fixtureVersion: VERSION });
  for (const d of SEED_DOCS) {
    store._addDocRecord('claimant', {
      name: d.name,
      mime: d.mime || 'text/plain',
      size: d.size || Buffer.byteLength(d.pages.join('\f')),
      sha256: engine.sha256(d.hashSeed || d.pages.join('\f')),
      pages: d.pages.map((text, i) => ({ n: i + 1, text })),
      source: 'fixture',
    }, {});
  }
  const bank = store.state.documents.find((d) => d.name === 'cancelled_cheque.txt');
  const ref = 'ACK-SYN-0042';
  store.setDelivery('claimant', bank.id, {
    status: 'acknowledged', reference: ref, fileName: 'ack_receipt_synthetic.txt',
    dataBase64: Buffer.from(SYNTHETIC_RECEIPT('ACKNOWLEDGEMENT', ref)).toString('base64'),
  });
  const id = store.state.documents.find((d) => d.name === 'photo_id.txt');
  store.setDelivery('claimant', id.id, { status: 'sent_claimed' });
  // Requirements go in last so the history never shows transient "missing" findings for documents already present.
  for (const c of extractRequirements(REQUEST_LETTER)) {
    store.addRequirement('claimant', { label: c.label, category: c.category, required: true });
  }
}

module.exports = { VERSION, CASE, REQUEST_LETTER, SEED_DOCS, SAMPLES, SYNTH_QUEUE, SYNTHETIC_RECEIPT, emptyState, seed };
