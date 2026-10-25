'use strict';
/**
 * ClaimTrail store: the single shared case/evidence/finding/event model behind BOTH the claimant
 * and intake views. Deterministic code owns state transitions, comparisons, hashes, evidence links
 * and permissions. Every mutation is atomic (rolled back on error) and appends to an append-only
 * event log. The log is append-only inside this process only; it is NOT cryptographically immutable.
 */
const fs = require('node:fs');
const path = require('node:path');
const engine = require('./engine');
const ocr = require('./ocr');
const ai = require('./ai');
const life = require('./lifecycle');
const fixtures = require('./fixtures');
const exporters = require('./exporters');
const dash = require('./dashboard');

const LIMITS = {
  MAX_UPLOAD_BYTES: 1_000_000,
  MAX_PROOF_BYTES: 200_000,
  MAX_TOTAL_BYTES: 8_000_000,
  MAX_DOCS: 40,
  MAX_REQS: 30,
  MAX_PAGES: 50,
  NOTE_MIN: 5,
  NOTE_MAX: 1000,
};
const EXT = {
  '.txt': { kind: 'text', mime: 'text/plain' }, '.md': { kind: 'text', mime: 'text/markdown' },
  '.csv': { kind: 'text', mime: 'text/csv' }, '.json': { kind: 'text', mime: 'application/json' },
  '.pdf': { kind: 'binary', mime: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  '.png': { kind: 'binary', mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47] },
  '.jpg': { kind: 'binary', mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  '.jpeg': { kind: 'binary', mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
};
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9\-_/]{5,39}$/;
const PAGE_BREAK = /\f|\n[ \t]*--- page break ---[ \t]*\n/i;
const SEV_ORDER = { blocker: 0, review: 1, info: 2 };
const FIELD_LABELS = {
  patientName: 'Patient name', policyNo: 'Policy number', claimRef: 'Claim reference', admitDate: 'Admission date',
  dischargeDate: 'Discharge date', billTotal: 'Bill total', claimedAmount: 'Claimed amount',
};

class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details || null;
  }
}

function sanitizeName(raw) {
  let s = String(raw == null ? '' : raw).split(/[\\/]/).pop();
  s = s.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[^\p{L}\p{N} ._()\-]/gu, '_').replace(/^\.+/, '').trim();
  if (s.length > 100) s = s.slice(-100);
  if (!s) throw new AppError(422, 'FILE_NAME_INVALID', 'The file needs a usable name.');
  return s;
}

function decodeBase64(b64, what = 'file') {
  if (typeof b64 !== 'string' || !b64.length) throw new AppError(422, 'FILE_EMPTY', `The ${what} is empty or missing.`);
  if (b64.length > Math.ceil(LIMITS.MAX_UPLOAD_BYTES * 1.4) + 8) throw new AppError(413, 'FILE_TOO_LARGE', `The ${what} is larger than the ${LIMITS.MAX_UPLOAD_BYTES / 1000} KB demo limit.`);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 === 1) throw new AppError(422, 'FILE_ENCODING_INVALID', `The ${what} content is not valid base64.`);
  return Buffer.from(b64, 'base64');
}

function requireNote(note, what = 'A note') {
  const t = typeof note === 'string' ? note.trim() : '';
  if (t.length < LIMITS.NOTE_MIN) throw new AppError(422, 'NOTE_REQUIRED', `${what} of at least ${LIMITS.NOTE_MIN} characters is required.`);
  if (t.length > LIMITS.NOTE_MAX) throw new AppError(422, 'NOTE_TOO_LONG', `Keep the note under ${LIMITS.NOTE_MAX} characters.`);
  return t;
}

const fieldValue = (f) => (f ? f.value : null);
function diffDocs(a, b) {
  const keys = new Set([...Object.keys(a.fields || {}), ...Object.keys(b.fields || {})]);
  const fields = [];
  for (const k of keys) {
    const x = fieldValue((a.fields || {})[k]);
    const y = fieldValue((b.fields || {})[k]);
    if (x !== y) fields.push({ field: k, label: FIELD_LABELS[k] || k, from: x, to: y, change: x === null ? 'added' : y === null ? 'removed' : 'changed' });
  }
  const readable = (d) => d.pages.filter((p) => engine.pageReadable(p.text)).length;
  return {
    hashChanged: a.sha256 !== b.sha256,
    pages: { from: a.pages.length, to: b.pages.length },
    readablePages: { from: readable(a), to: readable(b) },
    type: { from: a.classification.type, to: b.classification.type },
    fields,
    unchangedFields: keys.size - fields.length,
  };
}

class Store {
  constructor({ now = () => new Date(), file = null } = {}) {
    this.now = now;
    this.file = file;
    this.state = null;
    this._analysis = null;
    this.startupNotice = null;
    if (!(file && this.load())) this.reset();
  }

  /* ---------- persistence ---------- */
  load() {
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!s || s.version !== fixtures.VERSION || !Array.isArray(s.documents) || !Array.isArray(s.events) || !s.case || !s.ledger) throw new Error('unexpected shape');
      this.state = s;
      this._analysis = null;
      return true;
    } catch (e) {
      if (e.code !== 'ENOENT') this.startupNotice = 'Saved demo data could not be read; the fixture was restored.';
      return false;
    }
  }
  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.saveError = e.message;
    }
  }

  /** Delete all demo data (uploads, proofs, notes, history) and restore the original fixture. */
  reset() {
    const realNow = this.now;
    const end = realNow().getTime();
    const start = end - 3 * 3600 * 1000;
    let tick = 0;
    this.now = () => new Date(Math.min(end, start + 20_000 * tick++));
    try {
      this.state = fixtures.emptyState();
      this._analysis = null;
      fixtures.seed(this);
    } finally {
      this.now = realNow;
    }
    this.save();
  }

  /* ---------- plumbing ---------- */
  get status() { return this.state.case.status; }
  _emit(type, actor, summary, data = {}) {
    const seq = this.state.events.length + 1;
    this.state.events.push({ seq, at: this.now().toISOString(), actor, type, summary, data });
    return seq;
  }
  _check(role, action) {
    const c = life.check(role, action, this.status);
    if (!c.ok) throw new AppError(c.code === 'FORBIDDEN_ROLE' ? 403 : 409, c.code, c.message);
  }
  /** Run fn atomically: any throw restores the previous state, so failed calls never leave partial changes. */
  _atomic(fn) {
    const backup = JSON.stringify(this.state);
    try {
      const out = fn();
      this._afterChange();
      return out;
    } catch (e) {
      this.state = JSON.parse(backup);
      this._analysis = null;
      throw e;
    }
  }
  _do(role, action, fn) {
    this._check(role, action);
    return this._atomic(fn);
  }
  _afterChange() {
    this._analysis = null;
    this._syncLinks();
    this._analysis = null;
    this._syncLedger();
    this.save();
  }
  analysis() {
    if (!this._analysis) this._analysis = engine.analyze({ requirements: this.state.requirements, documents: this.state.documents, links: this.state.links });
    return this._analysis;
  }
  activeDocs() { return this.state.documents.filter((d) => !d.supersededBy); }
  _doc(id, { active = true } = {}) {
    const d = this.state.documents.find((x) => x.id === id);
    if (!d) throw new AppError(404, 'DOC_NOT_FOUND', `Document ${id} was not found.`);
    if (active && d.supersededBy) throw new AppError(409, 'DOC_SUPERSEDED', `${d.name} has been replaced or withdrawn.`);
    return d;
  }

  _syncLinks() {
    const S = this.state;
    const reqIds = new Set(S.requirements.map((r) => r.id));
    S.links = S.links.filter((l) => reqIds.has(l.reqId));
    for (const s of engine.suggestLinks(S.requirements, S.documents)) {
      const id = `L-${s.reqId}-${s.docId}`;
      const ex = S.links.find((l) => l.id === id);
      if (!ex) S.links.push({ id, reqId: s.reqId, docId: s.docId, page: s.page, excerpt: s.excerpt, confidence: s.confidence, reason: s.reason, decision: 'suggested', decidedBy: null, decidedAt: null, note: null, source: 'rules' });
      else if (ex.decision === 'suggested') Object.assign(ex, { page: s.page, excerpt: s.excerpt, confidence: s.confidence, reason: s.reason });
    }
    for (const l of S.links) {
      const d = S.documents.find((x) => x.id === l.docId);
      if ((!d || d.supersededBy) && l.decision !== 'superseded') l.decision = 'superseded';
    }
  }

  _syncLedger() {
    const L = this.state.ledger;
    const now = this.now().toISOString();
    const cur = new Map(this.analysis().findings.map((f) => [f.key, f]));
    for (const f of cur.values()) {
      const e = L[f.key];
      if (!e) {
        L[f.key] = {
          key: f.key, code: f.code, severity: f.severity, title: f.title, explanation: f.explanation, evidence: f.evidence, fingerprint: f.fingerprint,
          reqIds: f.reqIds || [], status: 'open', firstSeenAt: now, lastSeenAt: now, resolvedAt: null, resolution: null, reopenCount: 0,
          history: [{ at: now, action: 'opened', by: 'system', note: null }],
        };
        this._emit('finding_opened', 'system', `${f.code}: ${f.title}`, { key: f.key, code: f.code, severity: f.severity });
        continue;
      }
      let reopenWhy = null;
      if (e.status === 'resolved') {
        const stays = e.resolution.kind === 'reviewer_note' && e.fingerprint === f.fingerprint;
        if (!stays) reopenWhy = e.resolution.kind === 'reviewer_note' ? 'The underlying evidence changed after the reviewer resolved this finding.' : 'The issue was detected again.';
      }
      e.lastSeenAt = now;
      if (e.status === 'open' || reopenWhy) {
        Object.assign(e, { code: f.code, severity: f.severity, title: f.title, explanation: f.explanation, evidence: f.evidence, fingerprint: f.fingerprint, reqIds: f.reqIds || [] });
      }
      if (reopenWhy) {
        e.status = 'open'; e.resolvedAt = null; e.resolution = null; e.reopenCount += 1;
        e.history.push({ at: now, action: 'reopened', by: 'system', note: reopenWhy });
        this._emit('finding_reopened', 'system', `${e.code}: ${e.title}`, { key: e.key, reason: reopenWhy });
      }
    }
    for (const e of Object.values(L)) {
      if (e.status === 'open' && !cur.has(e.key)) {
        e.status = 'resolved'; e.resolvedAt = now;
        e.resolution = { kind: 'evidence_changed', note: 'No longer detected after the evidence changed.', by: 'system', at: now };
        e.history.push({ at: now, action: 'resolved', by: 'system', note: e.resolution.note });
        this._emit('finding_resolved', 'system', `${e.code}: ${e.title}`, { key: e.key, how: 'evidence_changed' });
      }
    }
  }

  findingsList() {
    return Object.values(this.state.ledger).sort((a, b) =>
      (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) ||
      SEV_ORDER[a.severity] - SEV_ORDER[b.severity] ||
      (a.firstSeenAt < b.firstSeenAt ? -1 : a.firstSeenAt > b.firstSeenAt ? 1 : 0) ||
      (a.key < b.key ? -1 : 1));
  }
  openBlocking() { return this.findingsList().filter(engine.isBlocking); }

  /* ---------- requirements ---------- */
  _validReq({ label, category }) {
    const l = typeof label === 'string' ? label.trim() : '';
    if (l.length < 3 || l.length > 80) throw new AppError(422, 'REQUIREMENT_INVALID', 'Requirement label must be 3 to 80 characters.');
    if (typeof category !== 'string' || !Object.prototype.hasOwnProperty.call(engine.TYPES, category)) {
      throw new AppError(422, 'REQUIREMENT_INVALID', `Choose a category: ${engine.TYPE_ORDER.join(', ')}.`);
    }
    return { label: l, category };
  }
  addRequirement(role, input) {
    return this._do(role, 'requirement.edit', () => {
      const { label, category } = this._validReq(input || {});
      const S = this.state;
      if (S.requirements.length >= LIMITS.MAX_REQS) throw new AppError(422, 'TOO_MANY_REQUIREMENTS', 'Requirement limit reached for the demo.');
      if (S.requirements.some((r) => r.label.toLowerCase() === label.toLowerCase())) throw new AppError(409, 'REQUIREMENT_EXISTS', 'A requirement with that label already exists.');
      const req = { id: `R-${++S.counters.req}`, label, category, required: input.required !== false };
      S.requirements.push(req);
      this._emit('requirement_added', role, `Requirement added: ${label}`, { reqId: req.id, category, required: req.required });
      return req;
    });
  }
  updateRequirement(role, id, patch) {
    return this._do(role, 'requirement.edit', () => {
      const req = this.state.requirements.find((r) => r.id === id);
      if (!req) throw new AppError(404, 'REQUIREMENT_NOT_FOUND', `Requirement ${id} was not found.`);
      patch = patch || {};
      const next = this._validReq({ label: patch.label === undefined ? req.label : patch.label, category: patch.category === undefined ? req.category : patch.category });
      if (patch.required !== undefined && typeof patch.required !== 'boolean') throw new AppError(422, 'REQUIREMENT_INVALID', '"required" must be true or false.');
      if (this.state.requirements.some((r) => r.id !== id && r.label.toLowerCase() === next.label.toLowerCase())) throw new AppError(409, 'REQUIREMENT_EXISTS', 'A requirement with that label already exists.');
      const before = { ...req };
      Object.assign(req, next, patch.required === undefined ? {} : { required: patch.required });
      this._emit('requirement_updated', role, `Requirement updated: ${req.label}`, { reqId: id, before: { label: before.label, category: before.category, required: before.required }, after: { label: req.label, category: req.category, required: req.required } });
      return req;
    });
  }
  removeRequirement(role, id) {
    return this._do(role, 'requirement.edit', () => {
      const i = this.state.requirements.findIndex((r) => r.id === id);
      if (i < 0) throw new AppError(404, 'REQUIREMENT_NOT_FOUND', `Requirement ${id} was not found.`);
      const [req] = this.state.requirements.splice(i, 1);
      this._emit('requirement_removed', role, `Requirement removed: ${req.label}`, { reqId: id });
      return { removed: id };
    });
  }
  extractCandidates(role, text) {
    this._check(role, 'requirement.extract');
    if (typeof text !== 'string' || !text.trim()) throw new AppError(422, 'TEXT_REQUIRED', 'Paste the insurer request text first.');
    if (text.length > 5000) throw new AppError(413, 'TEXT_TOO_LONG', 'Request text is limited to 5000 characters.');
    const existing = new Set(this.state.requirements.map((r) => r.label.toLowerCase()));
    return { mode: engine.MODE, live: false, candidates: ai.extractCandidates(text).map((c) => ({ ...c, alreadyAdded: existing.has(c.label.toLowerCase()) })) };
  }

  /* ---------- documents ---------- */
  _parseUpload({ name, dataBase64 }) {
    const fileName = sanitizeName(name);
    const ext = path.extname(fileName).toLowerCase();
    const spec = EXT[ext];
    if (!spec) throw new AppError(415, 'UNSUPPORTED_FILE_TYPE', `Unsupported file type "${ext || 'none'}". Allowed: ${Object.keys(EXT).join(', ')}.`);
    const buf = decodeBase64(dataBase64);
    if (buf.length === 0) throw new AppError(422, 'FILE_EMPTY', 'The file is empty.');
    if (buf.length > LIMITS.MAX_UPLOAD_BYTES) throw new AppError(413, 'FILE_TOO_LARGE', `The file is larger than the ${LIMITS.MAX_UPLOAD_BYTES / 1000} KB demo limit.`);
    let pages;
    let extraction = { kind: 'text', ocrAvailable: false, engine: null, note: null };
    if (spec.kind === 'text') {
      if (buf.includes(0)) throw new AppError(415, 'FILE_CONTENT_MISMATCH', `${fileName} contains binary data but has a text extension.`);
      const text = buf.toString('utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
      pages = text.split(PAGE_BREAK).map((t, i) => ({ n: i + 1, text: t.trim() }));
      if (pages.length > LIMITS.MAX_PAGES) throw new AppError(422, 'TOO_MANY_PAGES', `Limit is ${LIMITS.MAX_PAGES} pages per document.`);
    } else {
      if (!spec.magic.every((b, i) => buf[i] === b)) throw new AppError(415, 'FILE_CONTENT_MISMATCH', `${fileName} does not look like a real ${ext} file.`);
      const res = ocr.extract(buf, ext, { maxPages: Math.min(ocr.MAX_PAGES, LIMITS.MAX_PAGES) });
      pages = res.pages;
      extraction = { kind: ext === '.pdf' ? 'pdf' : 'image', ocrAvailable: res.available, engine: res.available ? ocr.status().engine : null, note: res.note || null };
    }
    return { name: fileName, mime: spec.mime, size: buf.length, sha256: engine.sha256(buf), pages, source: 'upload', extraction };
  }

  _addDocRecord(role, rec, { replaces = null, sampleId = null } = {}) {
    return this._atomic(() => {
      const S = this.state;
      const active = this.activeDocs();
      if (active.length >= LIMITS.MAX_DOCS) throw new AppError(422, 'TOO_MANY_DOCUMENTS', 'Document limit reached for the demo.');
      if (S.documents.reduce((n, d) => n + (d.size || 0), 0) + rec.size > LIMITS.MAX_TOTAL_BYTES) throw new AppError(413, 'PACKET_TOO_LARGE', 'The demo packet size limit would be exceeded. Reset the demo to clear data.');
      let old = null;
      if (replaces) {
        old = active.find((d) => d.id === replaces);
        if (!old) throw new AppError(404, 'DOC_NOT_FOUND', `Document ${replaces} was not found or is already replaced.`);
        if (old.sha256 === rec.sha256) throw new AppError(422, 'REUPLOAD_IDENTICAL', `${rec.name} is byte-identical to ${old.name}; nothing would change.`);
      } else if (active.some((d) => d.name.toLowerCase() === rec.name.toLowerCase())) {
        throw new AppError(409, 'NAME_EXISTS', `A document named "${rec.name}" is already in the packet. Use Replace on it to upload a corrected version, or rename the file.`);
      }
      const doc = {
        id: `D-${String(++S.counters.doc).padStart(3, '0')}`, name: rec.name, mime: rec.mime, size: rec.size, sha256: rec.sha256, pages: rec.pages,
        source: rec.source, extraction: rec.extraction || { kind: 'text', ocrAvailable: false, engine: null, note: null }, sampleId, addedBy: role, addedAt: this.now().toISOString(), addedSeq: null, classification: null, fields: null,
        supersededBy: null, replaces: old ? old.id : null, replaceDiff: null, delivery: { status: 'not_sent' },
      };
      doc.classification = ai.classify(doc);
      doc.fields = engine.extractFields(doc);
      if (old) { doc.replaceDiff = diffDocs(old, doc); old.supersededBy = doc.id; }
      S.documents.push(doc);
      const seq = this._emit('document_added', role, `Document added: ${doc.name}`, {
        docId: doc.id, name: doc.name, sha256: doc.sha256.slice(0, 12), pages: doc.pages.length, detectedType: doc.classification.type, replaces: old ? old.id : null,
        ocrPages: doc.pages.filter((p) => p.ocr && p.ocr.method === 'ocr').length, ocrRejected: doc.pages.filter((p) => p.ocr && p.ocr.status === 'rejected_low_confidence').length,
      });
      doc.addedSeq = seq;
      S.case.lastEvidenceChangeSeq = seq;
      if (old) {
        this._emit('document_replaced', role, `${old.name} replaced by ${doc.name}`, { from: old.id, to: doc.id, changedFields: doc.replaceDiff.fields.length, readablePages: doc.replaceDiff.readablePages });
      }
      return doc;
    });
  }

  uploadDocument(role, { name, dataBase64, replaces } = {}) {
    this._check(role, 'document.add');
    return this._addDocRecord(role, this._parseUpload({ name, dataBase64 }), { replaces: replaces || null });
  }

  samples() {
    const used = new Set(this.state.documents.map((d) => d.sampleId).filter(Boolean));
    return fixtures.SAMPLES.map((s) => {
      const target = s.replacesName ? this.activeDocs().find((d) => d.name === s.replacesName) : null;
      return { id: s.id, name: s.name, title: s.title, note: s.note, replacesName: s.replacesName, replacesDocId: target ? target.id : null, used: used.has(s.id) };
    });
  }
  addSample(role, { sampleId } = {}) {
    this._check(role, 'document.add');
    const s = fixtures.SAMPLES.find((x) => x.id === sampleId);
    if (!s) throw new AppError(404, 'SAMPLE_NOT_FOUND', `Unknown sample ${sampleId}.`);
    if (this.state.documents.some((d) => d.sampleId === s.id)) throw new AppError(409, 'SAMPLE_ALREADY_ADDED', `${s.title} was already added in this demo run. Reset the demo to start over.`);
    const target = s.replacesName ? this.activeDocs().find((d) => d.name === s.replacesName) : null;
    const text = s.pages.join('\f');
    return this._addDocRecord(role, { name: s.name, mime: 'text/plain', size: Buffer.byteLength(text), sha256: engine.sha256(text), pages: s.pages.map((t, i) => ({ n: i + 1, text: t })), source: 'sample' }, { replaces: target ? target.id : null, sampleId: s.id });
  }

  withdrawDocument(role, id, { reason } = {}) {
    return this._do(role, 'document.withdraw', () => {
      const doc = this._doc(id);
      const note = requireNote(reason, 'A reason');
      doc.supersededBy = 'WITHDRAWN';
      doc.withdrawn = { reason: note, by: role, at: this.now().toISOString() };
      this.state.case.lastEvidenceChangeSeq = this._emit('document_withdrawn', role, `Document withdrawn: ${doc.name}`, { docId: id, reason: note });
      return { withdrawn: id };
    });
  }

  _parseProof(input, label) {
    if (!input || typeof input !== 'object') throw new AppError(422, 'PROOF_REQUIRED', `${label} needs proof: an insurer reference and an attached receipt or acknowledgement file.`);
    const reference = typeof input.reference === 'string' ? input.reference.trim() : '';
    if (!REF_RE.test(reference)) throw new AppError(422, 'PROOF_REFERENCE_INVALID', `${label} needs a reference of 6 to 40 letters, digits, "-", "_" or "/".`);
    if (typeof input.dataBase64 !== 'string' || !input.dataBase64.length || !input.fileName) throw new AppError(422, 'PROOF_FILE_REQUIRED', `${label} needs a proof file attached (a fictional receipt is fine in the demo).`);
    const fileName = sanitizeName(input.fileName);
    const buf = decodeBase64(input.dataBase64, 'proof file');
    if (!buf.length) throw new AppError(422, 'PROOF_FILE_REQUIRED', 'The proof file is empty.');
    if (buf.length > LIMITS.MAX_PROOF_BYTES) throw new AppError(413, 'PROOF_FILE_TOO_LARGE', `The proof file is larger than ${LIMITS.MAX_PROOF_BYTES / 1000} KB.`);
    const preview = buf.includes(0) ? '(binary file)' : buf.toString('utf8').slice(0, 300);
    return { reference, proof: { fileName, sha256: engine.sha256(buf), size: buf.length, preview } };
  }

  setDelivery(role, docId, input = {}) {
    return this._do(role, 'document.delivery', () => {
      const doc = this._doc(docId);
      const status = input.status;
      if (!['not_sent', 'sent_claimed', 'acknowledged'].includes(status)) throw new AppError(422, 'DELIVERY_INVALID', 'Delivery status must be not_sent, sent_claimed or acknowledged.');
      const at = this.now().toISOString();
      if (status === 'acknowledged') {
        const { reference, proof } = this._parseProof({ reference: input.reference, fileName: input.fileName, dataBase64: input.dataBase64 }, 'Marking an item acknowledged');
        doc.delivery = { status, ackRef: reference, proof, at, by: role };
      } else doc.delivery = { status, at, by: role };
      this._emit('delivery_updated', role, `Delivery of ${doc.name}: ${status.replace('_', ' ')}`, { docId, status, ackRef: doc.delivery.ackRef || null, proofSha256: doc.delivery.proof ? doc.delivery.proof.sha256.slice(0, 12) : null });
      return doc.delivery;
    });
  }

  getPage(docId, n) {
    const doc = this._doc(docId, { active: false });
    const page = doc.pages[Number(n) - 1];
    if (!page) throw new AppError(404, 'PAGE_NOT_FOUND', `${doc.name} has no page ${n}.`);
    return { docId, name: doc.name, n: page.n, of: doc.pages.length, text: page.text, readable: engine.pageReadable(page.text), isImage: doc.mime.startsWith('image/') || doc.mime === 'application/pdf', superseded: !!doc.supersededBy,
      ocr: page.ocr ? { method: page.ocr.method, engine: page.ocr.engine, status: page.ocr.status, confidence: page.ocr.confidence, rawChars: page.ocr.rawChars || 0 } : null, ocrNote: (doc.extraction && doc.extraction.note) || null };
  }

  /* ---------- links ---------- */
  decideLink(role, linkId, { decision, note } = {}) {
    return this._do(role, 'link.decide', () => {
      if (!['accepted', 'rejected', 'suggested'].includes(decision)) throw new AppError(422, 'DECISION_INVALID', 'Decision must be accepted, rejected or suggested.');
      const l = this.state.links.find((x) => x.id === linkId);
      if (!l) throw new AppError(404, 'LINK_NOT_FOUND', `Evidence link ${linkId} was not found.`);
      this._doc(l.docId);
      let n = null;
      if (decision === 'rejected') n = requireNote(note, 'A reason for rejecting a match');
      if (decision === 'accepted') {
        const v = engine.validateLink(l, this.state.documents);
        if (!v.valid) throw new AppError(422, 'PROVENANCE_INVALID', `This match cannot be accepted: ${v.problems.join('; ')}.`);
        n = typeof note === 'string' && note.trim() ? note.trim().slice(0, LIMITS.NOTE_MAX) : null;
      }
      Object.assign(l, { decision, decidedBy: decision === 'suggested' ? null : role, decidedAt: this.now().toISOString(), note: n });
      this._emit('link_decided', role, `Match ${decision}: ${l.id}`, { linkId, decision, note: n });
      return l;
    });
  }

  _reviewerConfirmed(st) {
    const l = st.linkId && this.state.links.find((x) => x.id === st.linkId);
    return !!(l && l.decision === 'accepted' && l.decidedBy === 'reviewer');
  }

  /** Reviewer bulk-confirms only clean suggestions: matched, readable page, valid source. Everything else stays for a person. */
  acceptSuggested(role) {
    return this._do(role, 'link.acceptAll', () => {
      const accepted = [], skipped = [];
      const at = this.now().toISOString();
      for (const st of this.analysis().statuses) {
        const l = st.linkId && this.state.links.find((x) => x.id === st.linkId);
        if (st.status !== 'matched') { skipped.push(st.reqId); continue; }
        if (!l || this._reviewerConfirmed(st)) continue;
        if (!engine.validateLink(l, this.state.documents).valid) { skipped.push(st.reqId); continue; }
        Object.assign(l, { decision: 'accepted', decidedBy: role, decidedAt: at, note: null });
        accepted.push(l.id);
        this._emit('link_decided', role, `Match accepted: ${l.id}`, { linkId: l.id, decision: 'accepted', bulk: true });
      }
      if (!accepted.length) throw new AppError(409, 'NOTHING_TO_ACCEPT', 'There are no clean suggested matches left to accept. Missing, unreadable, ambiguous and low-confidence items need a person.');
      return { accepted, skipped };
    });
  }

  manualLink(role, { reqId, docId, page } = {}) {
    return this._do(role, 'link.manual', () => {
      const req = this.state.requirements.find((r) => r.id === reqId);
      if (!req) throw new AppError(404, 'REQUIREMENT_NOT_FOUND', `Requirement ${reqId} was not found.`);
      const doc = this._doc(docId);
      const p = Number(page);
      if (!Number.isInteger(p) || p < 1 || p > doc.pages.length) throw new AppError(422, 'PROVENANCE_INVALID', `${doc.name} has pages 1 to ${doc.pages.length}; choose one of them.`);
      const text = doc.pages[p - 1].text;
      const firstLine = String(text).split('\n').map((s) => s.trim()).find(Boolean);
      const excerpt = engine.pageReadable(text) ? engine.clip(firstLine) : engine.UNREADABLE_EXCERPT;
      const id = `L-${reqId}-${docId}`;
      let l = this.state.links.find((x) => x.id === id);
      const fields = { page: p, excerpt, decision: 'accepted', decidedBy: role, decidedAt: this.now().toISOString(), note: 'Selected manually' };
      if (l) Object.assign(l, fields);
      else {
        l = { id, reqId, docId, confidence: 1, reason: `Selected manually by the ${role}`, source: 'manual', ...fields };
        this.state.links.push(l);
      }
      this._emit('link_manual', role, `Evidence chosen for ${req.label}: ${doc.name} p.${p}`, { linkId: id, reqId, docId, page: p });
      return l;
    });
  }

  /* ---------- findings ---------- */
  resolveFinding(role, key, { note } = {}) {
    return this._do(role, 'finding.resolve', () => {
      const e = this.state.ledger[key];
      if (!e) throw new AppError(404, 'FINDING_NOT_FOUND', 'Finding not found.');
      if (e.status !== 'open') throw new AppError(409, 'FINDING_NOT_OPEN', 'This finding is already resolved.');
      if (e.code === 'PROVENANCE_MISSING') throw new AppError(422, 'NOT_OVERRIDABLE', 'Missing provenance cannot be overridden; fix the evidence link instead.');
      const n = requireNote(note, 'A resolution note');
      const at = this.now().toISOString();
      e.status = 'resolved'; e.resolvedAt = at;
      e.resolution = { kind: 'reviewer_note', note: n, by: role, at };
      e.history.push({ at, action: 'resolved', by: role, note: n });
      this._emit('finding_resolved', role, `Reviewer resolved ${e.code}: ${e.title}`, { key, how: 'reviewer_note', note: n });
      return e;
    });
  }
  reopenFinding(role, key, { note } = {}) {
    return this._do(role, 'finding.reopen', () => {
      const e = this.state.ledger[key];
      if (!e) throw new AppError(404, 'FINDING_NOT_FOUND', 'Finding not found.');
      if (e.status !== 'resolved') throw new AppError(409, 'FINDING_NOT_RESOLVED', 'Only resolved findings can be reopened.');
      const n = requireNote(note, 'A reason for reopening');
      const at = this.now().toISOString();
      e.status = 'open'; e.resolvedAt = null; e.resolution = null; e.reopenCount += 1;
      e.history.push({ at, action: 'reopened', by: role, note: n });
      this._emit('finding_reopened', role, `Reviewer reopened ${e.code}: ${e.title}`, { key, note: n });
      return e;
    });
  }
  rerun(role) {
    return this._do(role, 'checks.rerun', () => {
      const prev = this.state.lastCheck;
      const cur = {};
      for (const f of this.findingsList()) cur[f.key] = { status: f.status, fingerprint: f.fingerprint };
      const keys = Object.keys(cur);
      const wasOpen = (k) => prev && prev.map[k] && prev.map[k].status === 'open';
      const diff = {
        newlyOpen: keys.filter((k) => cur[k].status === 'open' && !wasOpen(k)),
        resolved: keys.filter((k) => cur[k].status === 'resolved' && wasOpen(k)),
        stillOpen: keys.filter((k) => cur[k].status === 'open' && wasOpen(k)),
      };
      const at = this.now().toISOString();
      this.state.lastCheck = { at, by: role, map: cur, diff, openBlockers: this.openBlocking().length, mode: engine.MODE };
      this._emit('checks_rerun', role, `Checks re-run: ${diff.newlyOpen.length} new, ${diff.resolved.length} resolved, ${diff.stillOpen.length} still open`, { openBlockers: this.openBlocking().length });
      return this.state.lastCheck;
    });
  }

  /* ---------- drafts (text only; there is no send capability anywhere) ---------- */
  _newDraft(role, kind) {
    const a = this.analysis();
    const labels = new Map(this.state.requirements.map((r) => [r.id, r.label]));
    const ctx = {
      case: this.state.case,
      statuses: a.statuses.map((s) => ({ ...s, label: labels.get(s.reqId) })),
      openFindings: this.findingsList().filter((f) => f.status === 'open'),
    };
    const d = ai.draftWording(kind, ctx);
    const draft = { id: `DR-${++this.state.counters.draft}`, kind, subject: d.subject, body: d.body, mode: d.mode, createdAt: this.now().toISOString(), createdBy: role, sent: false };
    this.state.drafts.push(draft);
    this._emit('draft_created', role, `Draft created (${kind.replace('_', ' ')}); not sent`, { draftId: draft.id, kind });
    return draft;
  }
  createDraft(role, kind) {
    if (kind !== 'follow_up' && kind !== 'correction_request') throw new AppError(422, 'DRAFT_KIND_INVALID', 'kind must be follow_up or correction_request.');
    return this._do(role, kind === 'follow_up' ? 'draft.followup' : 'draft.correction', () => this._newDraft(role, kind));
  }

  /* ---------- lifecycle ---------- */
  _guardReasons(t, { skipProof = false, proof = null } = {}) {
    const reasons = [];
    const S = this.state;
    for (const g of t.guards) {
      if (g === 'readiness') reasons.push(...this.analysis().readiness.blockers);
      else if (g === 'proof') {
        if (!skipProof && !proof) reasons.push('Proof is required: enter the insurer reference and attach the receipt or acknowledgement file.');
      } else if (g === 'openFindings') {
        if (this.openBlocking().length === 0) reasons.push('There are no open findings to request corrections for.');
      } else if (g === 'noBlockers') {
        for (const f of this.openBlocking()) reasons.push(`Open ${f.severity === 'blocker' ? 'blocker' : 'review item'}: ${f.title} [${f.code}]`);
      } else if (g === 'confirmed') {
        for (const st of this.analysis().statuses) {
          const req = S.requirements.find((r) => r.id === st.reqId);
          if (req && req.required && st.status === 'matched' && !this._reviewerConfirmed(st)) reasons.push(`Match not yet confirmed by the reviewer: ${req.label}`);
        }
      } else if (g === 'newEvidence') {
        if (!(S.case.lastEvidenceChangeSeq > S.case.actionRequiredSeq)) reasons.push('No new, replaced or withdrawn evidence has been recorded since the correction request.');
      }
    }
    return reasons;
  }
  transitionsFor(role) {
    return life.TRANSITIONS.filter((t) => t.from === this.status && t.role === role).map((t) => {
      const blockedReasons = this._guardReasons(t, { skipProof: true });
      return { to: t.to, toLabel: life.LABELS[t.to], label: t.label, requiresProof: t.guards.includes('proof'), blockedReasons, allowed: blockedReasons.length === 0 };
    });
  }
  waitingOn(role) {
    const others = life.TRANSITIONS.filter((t) => t.from === this.status && t.role !== role);
    return others.length ? { role: others[0].role, actions: others.map((t) => t.label) } : null;
  }
  transition(role, to, { proof } = {}) {
    if (!life.ROLES.includes(role)) throw new AppError(403, 'FORBIDDEN_ROLE', 'Unknown role.');
    const t = life.TRANSITIONS.find((x) => x.from === this.status && x.to === to);
    if (!t) throw new AppError(409, 'INVALID_TRANSITION', `Cannot move from "${life.LABELS[this.status]}" to "${life.LABELS[to] || to}".`);
    if (t.role !== role) throw new AppError(403, 'FORBIDDEN_ROLE', `Only the ${t.role} can perform "${t.label}".`);
    return this._atomic(() => {
      const reasons = this._guardReasons(t, { skipProof: true });
      let parsed = null;
      if (t.guards.includes('proof')) {
        try { parsed = this._parseProof(proof, t.to === 'submitted' ? 'Recording a submission' : 'Recording a resubmission'); }
        catch (e) { if (e instanceof AppError) reasons.push(e.message); else throw e; }
        if (parsed && this.state.submissions.some((s) => s.reference.toLowerCase() === parsed.reference.toLowerCase())) {
          reasons.push(`Reference ${parsed.reference} was already used for an earlier submission; enter the new reference.`);
          parsed = null;
        }
      }
      if (reasons.length) {
        const onlyProof = t.guards.includes('proof') && !parsed && reasons.length === 1;
        throw new AppError(422, onlyProof ? 'PROOF_REQUIRED' : 'TRANSITION_BLOCKED', `Cannot ${t.label.toLowerCase()}.`, { reasons });
      }
      const S = this.state;
      const prev = S.case.status;
      if (parsed) {
        S.submissions.push({ n: S.submissions.length + 1, kind: t.to === 'submitted' ? 'initial' : 'resubmission', reference: parsed.reference, proof: parsed.proof, at: this.now().toISOString(), by: role, packet: this.activeDocs().map((d) => ({ id: d.id, name: d.name, sha256: d.sha256 })) });
      }
      if (t.to === 'action_required') {
        S.case.actionRequiredSeq = S.events.length;
        this._newDraft(role, 'correction_request');
      }
      S.case.status = t.to;
      this._emit('status_changed', role, `${life.LABELS[prev]} → ${life.LABELS[t.to]}`, { from: prev, to: t.to, reference: parsed ? parsed.reference : null });
      return { from: prev, to: t.to };
    });
  }

  /* ---------- read models ---------- */
  nextAction() {
    const s = this.status;
    const a = this.analysis();
    const blockers = this.openBlocking().length;
    switch (s) {
      case 'draft': return 'Claimant: start preparing the packet';
      case 'preparing': return a.readiness.ready ? 'Claimant: mark the packet ready for review' : `Claimant: resolve ${a.readiness.blockers.length} readiness blocker(s)`;
      case 'ready_for_review': return 'Claimant: record the submission with proof';
      case 'submitted': return 'Reviewer: start intake review';
      case 'intake_review': return blockers ? `Reviewer: work through ${blockers} open finding(s) or request corrections` : this._unconfirmedNote('Reviewer: mark intake checks complete');
      case 'action_required': return 'Claimant: provide corrected evidence, then record the resubmission with proof';
      case 'resubmitted': return blockers ? `Reviewer: ${blockers} finding(s) still open; resolve them or request further corrections` : this._unconfirmedNote('Reviewer: mark intake checks complete');
      default: return 'None: configured intake checks passed (this is not a coverage decision)';
    }
  }

  _unconfirmedNote(done) {
    const n = this.analysis().statuses.filter((st) => st.status === 'matched' && !this._reviewerConfirmed(st) && (this.state.requirements.find((r) => r.id === st.reqId) || {}).required).length;
    return n ? `Reviewer: confirm ${n} suggested match(es), then mark intake checks complete` : done;
  }

  summary() {
    const list = this.findingsList();
    const open = list.filter((f) => f.status === 'open');
    return {
      openBlockers: open.filter(engine.isBlocking).length,
      openBlockerItems: open.filter((f) => f.severity === 'blocker').length,
      openInfo: open.filter((f) => f.severity === 'info').length,
      resolvedByEvidence: list.filter((f) => f.status === 'resolved' && f.resolution.kind === 'evidence_changed').length,
      resolvedByReviewer: list.filter((f) => f.status === 'resolved' && f.resolution.kind === 'reviewer_note').length,
      totalFindings: list.length,
    };
  }

  _docMeta(d) {
    return {
      id: d.id, name: d.name, mime: d.mime, size: d.size, sha256: d.sha256, source: d.source, sampleId: d.sampleId, addedBy: d.addedBy, addedAt: d.addedAt,
      classification: d.classification, fields: d.fields, supersededBy: d.supersededBy, withdrawn: d.withdrawn || null, replaces: d.replaces, replaceDiff: d.replaceDiff, delivery: d.delivery,
      isImage: d.mime.startsWith('image/') || d.mime === 'application/pdf',
      extraction: d.extraction || null,
      pages: d.pages.map((p) => ({ n: p.n, chars: p.text.length, readable: engine.pageReadable(p.text), ocr: p.ocr ? { method: p.ocr.method, status: p.ocr.status, confidence: p.ocr.confidence } : null })),
    };
  }
  view() {
    const S = this.state;
    const a = this.analysis();
    const labels = new Map(S.requirements.map((r) => [r.id, r.label]));
    return {
      case: { ...S.case, statusLabel: life.LABELS[S.case.status] },
      requirements: S.requirements,
      documents: S.documents.map((d) => this._docMeta(d)),
      links: S.links,
      statuses: a.statuses.map((s) => ({ ...s, label: labels.get(s.reqId) })),
      comparisons: a.comparisons,
      findings: this.findingsList(),
      readiness: a.readiness,
      dups: a.dups,
      events: S.events,
      drafts: S.drafts,
      submissions: S.submissions,
      lastCheck: S.lastCheck,
      summary: this.summary(),
    };
  }
  snapshot(role) {
    if (!life.ROLES.includes(role)) throw new AppError(403, 'FORBIDDEN_ROLE', 'Unknown role.');
    return {
      ...this.view(),
      role,
      meta: { demoData: true, ai: ai.providerInfo(), generatedAt: this.now().toISOString(), startupNotice: this.startupNotice },
      lifecycle: { states: life.STATES.map(([id, label]) => ({ id, label })), current: this.status },
      transitions: this.transitionsFor(role),
      waitingOn: this.waitingOn(role),
      can: life.capabilities(role, this.status),
      nextAction: this.nextAction(),
      ocr: ocr.status(),
      limits: { maxUploadBytes: LIMITS.MAX_UPLOAD_BYTES, maxProofBytes: LIMITS.MAX_PROOF_BYTES, extensions: Object.keys(EXT), categories: engine.TYPE_ORDER.map((t) => ({ id: t, label: engine.typeLabel(t) })) },
    };
  }

  queue(role) {
    this._check(role, 'queue.view');
    const live = { id: this.state.case.id, claimant: this.state.case.claimant, status: this.status, statusLabel: life.LABELS[this.status], openBlockers: this.summary().openBlockers, nextAction: this.nextAction(), live: true, ageHours: this._ageHours() };
    const rows = fixtures.SYNTH_QUEUE.map((r) => ({ id: r.id, claimant: r.claimant, status: r.status, statusLabel: life.LABELS[r.status], openBlockers: r.openBlockers, nextAction: r.nextAction, live: false, ageHours: r.ageDays * 24 }));
    return { demoData: true, rows: [live, ...rows] };
  }
  _ageHours() {
    const sub = this.state.submissions[0];
    const t0 = sub ? Date.parse(sub.at) : Date.parse(this.state.events[0].at);
    return Math.max(0, Math.round(((this.now().getTime() - t0) / 3600000) * 10) / 10);
  }
  dashboard(role) {
    this._check(role, 'dashboard.view');
    return dash.build({ synthRows: fixtures.SYNTH_QUEUE, live: this._liveMetrics() });
  }
  _liveMetrics() {
    const open = this.findingsList().filter(engine.isBlocking);
    const now = this.now().getTime();
    const oldest = open.length ? Math.max(...open.map((f) => now - Date.parse(f.firstSeenAt))) : 0;
    const ev = this.state.events;
    const sub = ev.find((e) => e.type === 'status_changed' && e.data.to === 'submitted');
    const tri = ev.find((e) => e.type === 'status_changed' && e.data.to === 'intake_review');
    return {
      openBlockers: open.length,
      oldestOpenBlockerMinutes: Math.round(oldest / 60000),
      correctionRounds: ev.filter((e) => e.type === 'status_changed' && e.data.to === 'action_required').length,
      timeToTriageMinutes: sub && tri ? Math.round((Date.parse(tri.at) - Date.parse(sub.at)) / 60000) : null,
      ...this.summary(),
    };
  }

  /* ---------- exports ---------- */
  manifest(role, format) {
    this._check(role, 'export');
    this._emit('export_generated', role, `Packet manifest exported (${format}); an export is not a submission`, { format });
    this._afterChange();
    const m = exporters.buildManifest(this.view(), this.now().toISOString());
    return format === 'md' ? { type: 'text/markdown; charset=utf-8', ext: 'md', body: exporters.manifestMarkdown(m) } : { type: 'application/json; charset=utf-8', ext: 'json', body: JSON.stringify(m, null, 2) };
  }
  missingChecklist(role, format) {
    this._check(role, 'export');
    this._emit('export_generated', role, `Missing-items checklist exported (${format}); an export is not a submission`, { format });
    this._afterChange();
    const c = exporters.buildMissing(this.view(), this.now().toISOString());
    return format === 'json' ? { type: 'application/json; charset=utf-8', ext: 'json', body: JSON.stringify(c, null, 2) } : { type: 'text/markdown; charset=utf-8', ext: 'md', body: exporters.missingMarkdown(c) };
  }
  report(role, format) {
    this._check(role, 'report.view');
    const r = exporters.buildReport(this.view(), this.now().toISOString(), this.openBlocking());
    return format === 'json' ? { type: 'application/json; charset=utf-8', ext: 'json', body: JSON.stringify(r, null, 2) } : { type: 'text/markdown; charset=utf-8', ext: 'md', body: exporters.reportMarkdown(r) };
  }
}

module.exports = { Store, AppError, LIMITS, EXT, diffDocs, sanitizeName, REF_RE };
