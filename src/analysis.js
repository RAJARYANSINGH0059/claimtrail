'use strict';
/**
 * Cloud analysis manager: the ONLY place that turns a user request into a Sarvam call.
 *
 *  - Off unless an operator enabled AI_PROVIDER=sarvam with a key; a user must ALSO send
 *    externalProcessingConsent === true for each file / translation (checked here, at the API layer).
 *  - Jobs live in memory only (TTL, small cap). The raw bytes are dropped as soon as the provider call ends.
 *    Extracted text is NOT in the case until a person inspects it and calls confirm().
 *  - A model result never accepts a link, clears a blocker or changes status: confirm() just adds a document through
 *    the same record path as any upload, flagged "verify against original"; deterministic rules re-run afterwards.
 *  - A global per-hour call budget and a concurrency cap protect the paid key on a public demo.
 *  - Translation is limited to the case's own insurer request text (no open proxy) and is rejected if it alters
 *    any ID, number, amount or date.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('./store');
const { publicAiStatus } = require('./config');
const { SarvamError, LANGS } = require('./providers/sarvam');
const i18n = require('./i18n');

const SAMPLE_SCANS = {
  lab_report_scan: { file: 'lab_report_scan.pdf', title: 'Synthetic lab report (image-only PDF)', language: 'en-IN' },
  pharmacy_bill_scan_corrected: { file: 'pharmacy_bill_scan_corrected.png', title: 'Synthetic pharmacy bill (PNG)', language: 'en-IN' },
};
const SAMPLES_DIR = path.join(__dirname, '..', 'samples');

class AnalysisManager {
  constructor({ store, config, provider = null, maxConcurrent = 2, ttlMs = 15 * 60_000, maxJobs = 8, budgetPerHour = 30, now = () => Date.now(), samplesDir = SAMPLES_DIR } = {}) {
    Object.assign(this, { store, config, provider, maxConcurrent, ttlMs, maxJobs, budgetPerHour, now, samplesDir });
    this.jobs = new Map();
    this.calls = [];
    this.translations = new Map();
  }

  enabled() { return this.config.ai.provider === 'sarvam' && !!this.provider && this.provider.configured; }

  status() {
    const s = publicAiStatus(this.config, { cloudDocuments: this.store.cloudDocumentCount() });
    s.features = { documentAnalysis: this.enabled(), translation: this.enabled() };
    s.sampleScans = this.enabled() ? Object.entries(SAMPLE_SCANS).map(([id, v]) => ({ id, title: v.title, language: v.language })) : [];
    s.supportedDocumentLanguages = this.enabled() ? [...LANGS] : [];
    s.uiLanguages = Object.keys(i18n.LANGS);
    s.limits = { callsPerHour: this.budgetPerHour, maxPages: 10 };
    return s;
  }

  _requireEnabled() {
    if (!this.enabled()) throw new AppError(503, 'AI_PROVIDER_DISABLED', this.config.ai.state === 'rules_only' ? 'Cloud analysis is switched off on this server (AI_PROVIDER=rules). The normal upload and local checks still work.' : this.config.ai.message);
  }
  _requireConsent(body) {
    if (body.externalProcessingConsent !== true) throw new AppError(422, 'CONSENT_REQUIRED', 'Explicit consent is required before anything is sent to an external AI service (externalProcessingConsent: true).');
  }
  _spend() {
    const cutoff = this.now() - 3_600_000;
    this.calls = this.calls.filter((t) => t > cutoff);
    if (this.calls.length >= this.budgetPerHour) throw new AppError(429, 'CLOUD_BUDGET_EXCEEDED', 'The demo\'s hourly limit for cloud calls has been reached. Try again later or continue with the offline checks.');
    this.calls.push(this.now());
  }
  _gc() {
    for (const [id, j] of this.jobs) if (j.status !== 'running' && this.now() - j.touched > this.ttlMs) this.jobs.delete(id);
    while (this.jobs.size > this.maxJobs) {
      const old = [...this.jobs.values()].find((j) => j.status !== 'running');
      if (!old) break;
      this.jobs.delete(old.id);
    }
  }
  _event(role, type, data) { try { this.store.recordCloudEvent(role, type, data); } catch { /* auditing must never break the request */ } }
  _job(role, id) {
    this._gc();
    const j = this.jobs.get(String(id));
    if (!j || j.role !== role) throw new AppError(404, 'ANALYSIS_NOT_FOUND', 'No such analysis (it may have expired).');
    return j;
  }
  _view(j) {
    const v = { id: j.id, status: j.status, name: j.name, mime: j.mime, size: j.size, language: j.language, createdAt: j.createdAt, provider: 'Sarvam Document AI', error: j.error || null };
    if (j.result && (j.status === 'ready' || j.status === 'confirmed')) {
      v.result = {
        providerJobId: j.result.jobId, partial: j.result.partial, usage: j.result.usage, confidence: 'not supplied',
        notice: 'Text extracted by Sarvam Document AI. Confidence is not supplied by the provider; verify amounts and IDs against the original document.',
        pages: j.result.pages.map((p) => ({ n: p.n, chars: p.text.length, text: p.text, readable: p.text.trim().length >= 20 })),
        fields: this.store.previewFields(j.result.pages),
      };
    }
    return v;
  }

  start(role, body = {}) {
    this._requireEnabled();
    this.store._check(role, 'document.add');
    this._requireConsent(body);
    let input, source = 'upload';
    if (body.sampleScanId !== undefined) {
      const s = SAMPLE_SCANS[body.sampleScanId];
      if (!s || !Object.prototype.hasOwnProperty.call(SAMPLE_SCANS, body.sampleScanId)) throw new AppError(404, 'SAMPLE_NOT_FOUND', 'Unknown sample scan.');
      input = this.store.prepareCloudInput(role, { name: s.file, dataBase64: fs.readFileSync(path.join(this.samplesDir, s.file)).toString('base64') });
      source = 'sample';
    } else input = this.store.prepareCloudInput(role, { name: body.name, dataBase64: body.dataBase64 });
    const language = body.language === undefined ? 'en-IN' : body.language;
    if (typeof language !== 'string' || !LANGS.has(language)) throw new AppError(422, 'LANGUAGE_UNSUPPORTED', 'Unsupported document language code.');
    this._gc();
    if ([...this.jobs.values()].filter((j) => j.status === 'running').length >= this.maxConcurrent) throw new AppError(429, 'ANALYSIS_BUSY', 'Too many analyses are running. Wait for one to finish.');
    this._spend();

    const id = crypto.randomBytes(9).toString('hex');
    const ac = new AbortController();
    const j = { id, role, status: 'running', name: input.name, mime: input.mime, size: input.size, sha256: input.sha256, language, createdAt: new Date(this.now()).toISOString(), touched: this.now(), ac, error: null, result: null, replaces: body.replaces || null };
    this.jobs.set(id, j);
    this._event(role, 'cloud_analysis_started', { provider: 'sarvam-document-ai', sha256: input.sha256.slice(0, 12), bytes: input.size, language, consent: true, source });
    let bytes = input.bytes;
    this.provider.digitise({ name: input.name, bytes, language, signal: ac.signal })
      .then((r) => { if (j.status !== 'running') return; j.result = r; j.status = 'ready'; this._event(role, 'cloud_analysis_ready', { jobId: r.jobId, pages: r.pages.length, partial: r.partial }); })
      .catch((e) => {
        if (j.status !== 'running') return;
        const safe = e instanceof SarvamError ? { code: e.code, message: e.message, status: e.status } : { code: 'ANALYSIS_FAILED', message: 'The analysis failed unexpectedly. Nothing was added to the case.', status: 500 };
        j.error = safe; j.status = 'failed';
        this._event(role, 'cloud_analysis_failed', { errorCode: safe.code });
      })
      .finally(() => { bytes = null; input.bytes = null; j.touched = this.now(); });
    return this._view(j);
  }

  get(role, id) { this.store._check(role, 'state.view'); const j = this._job(role, id); return this._view(j); }

  cancel(role, id) {
    const j = this._job(role, id);
    if (j.status === 'running') {
      j.status = 'cancelled'; j.ac.abort();
      this._event(role, 'cloud_analysis_cancelled', { provider: 'sarvam-document-ai', note: 'abandoned locally; the remote job may still complete' });
    } else if (j.status === 'ready') { j.status = 'discarded'; j.result = null; }
    else throw new AppError(409, 'ANALYSIS_NOT_CANCELLABLE', `This analysis is already ${j.status}.`);
    j.touched = this.now();
    return this._view(j);
  }

  confirm(role, id) {
    const j = this._job(role, id);
    if (j.status !== 'ready' || !j.result) throw new AppError(409, 'ANALYSIS_NOT_READY', `This analysis is ${j.status}; only a finished analysis can be added.`);
    const r = j.result;
    const note = r.partial ? `Partial result: ${r.usage.pages_failed != null ? r.usage.pages_failed : 'some'} page(s) could not be processed and appear unreadable.` : null;
    const doc = this.store.addCloudDocument(role, { name: j.name, mime: j.mime, size: j.size, sha256: j.sha256, pages: r.pages, jobId: r.jobId, language: j.language, partial: r.partial, note, replaces: j.replaces });
    j.status = 'confirmed'; j.touched = this.now();
    return { analysis: this._view(j), document: { id: doc.id, name: doc.name } };
  }

  async translate(role, body = {}) {
    this._requireEnabled();
    this.store._check(role, 'state.view');
    this._requireConsent(body);
    const target = body.target === undefined ? 'hi-IN' : body.target;
    if (target !== 'hi-IN') throw new AppError(422, 'LANGUAGE_UNSUPPORTED', 'Only Hindi (hi-IN) translation is enabled in this release.');
    if (body.scope !== undefined && body.scope !== 'request_letter') throw new AppError(422, 'SCOPE_UNSUPPORTED', 'Only the insurer request text of this case can be translated.');
    const source = this.store.state.case.requestLetter;
    if (typeof source !== 'string' || !source.trim()) throw new AppError(422, 'NOTHING_TO_TRANSLATE', 'This case has no insurer request text.');
    const key = crypto.createHash('sha256').update(source + '|' + target).digest('hex');
    if (this.translations.has(key)) return { ...this.translations.get(key), cached: true };
    this._spend();
    this._event(role, 'cloud_translation_requested', { provider: 'sarvam-translate', chars: source.length, target, consent: true });
    let out;
    try { out = await this.provider.translate({ text: source, source: 'en-IN', target }); } catch (e) {
      if (e instanceof SarvamError) throw new AppError(e.status, e.code, e.message);
      throw new AppError(500, 'TRANSLATION_FAILED', 'The translation failed unexpectedly. The original text is unchanged.');
    }
    const inv = i18n.checkInvariance(source, out.translatedText);
    if (!inv.ok) throw new AppError(422, 'TRANSLATION_ALTERED_VALUES', 'The machine translation changed an ID, number, amount or date, so it was discarded. The original text and the built-in Hindi guidance remain available.', { alteredTokens: inv.missing.slice(0, 10) });
    const result = { source, translated: out.translatedText, target, provider: 'Sarvam Translate (sarvam-translate:v1, formal)', machineTranslated: true, invariance: { ok: true } };
    this.translations.set(key, result);
    return { ...result, cached: false };
  }
}

module.exports = { AnalysisManager, SAMPLE_SCANS };
