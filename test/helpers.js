'use strict';
const { Store } = require('../src/store');

const FIXED = '2026-10-24T06:00:00.000Z';
const mkStore = (opts = {}) => new Store({ now: () => new Date(FIXED), ...opts });
const b64 = (s) => Buffer.from(s).toString('base64');
const proof = (reference = 'SUB-TEST-0001') => ({ reference, fileName: 'receipt_synthetic.txt', dataBase64: b64(`SYNTHETIC RECEIPT ${reference}`) });
const codes = (store, status = 'open') => store.findingsList().filter((f) => f.status === status).map((f) => f.code);
const open = (store, code) => store.findingsList().find((f) => f.status === 'open' && f.code === code);
const reqStatus = (store, label) => store.view().statuses.find((s) => s.label.toLowerCase().includes(label.toLowerCase()));

/** Claimant fixes what blocks readiness and records the first submission. */
function toSubmitted(store) {
  store.addSample('claimant', { sampleId: 'S-LAB' });
  store.addSample('claimant', { sampleId: 'S-PHARM' });
  store.transition('claimant', 'ready_for_review');
  store.transition('claimant', 'submitted', { proof: proof('SUB-TEST-0001') });
  return store;
}
function toIntakeReview(store) {
  toSubmitted(store);
  store.transition('reviewer', 'intake_review');
  return store;
}
const rejects = (fn, code, status) => {
  try { fn(); } catch (e) {
    if (e.code !== code) throw new Error(`expected ${code} but got ${e.code}: ${e.message}`);
    if (status && e.status !== status) throw new Error(`expected HTTP ${status} but got ${e.status}`);
    return e;
  }
  throw new Error(`expected ${code} but nothing was thrown`);
};

module.exports = { mkStore, b64, proof, codes, open, reqStatus, toSubmitted, toIntakeReview, rejects, FIXED };
