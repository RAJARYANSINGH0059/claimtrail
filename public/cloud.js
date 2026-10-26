// Optional cloud features (Sarvam) and the English/Hindi guidance panel.
// Rules: nothing here sends anything unless the person ticks an UNCHECKED consent box for that specific action; all
// provider text is rendered with textContent only (h() never uses innerHTML); results are shown for inspection and only
// join the packet when the person presses "Add"; adding never accepts a match, clears a blocker or changes the status.
import { h, chip, btn, field, modal, readFileB64, kb, table, row } from './ui.js';

const LANG_KEY = 'claimtrail.lang';
let lang = 'en';
try { const l = localStorage.getItem(LANG_KEY); if (l === 'en' || l === 'hi') lang = l; } catch { /* storage unavailable: English */ }

const DOC_LANG = { 'en-IN': 'English', 'hi-IN': 'Hindi (हिन्दी)', 'bn-IN': 'Bengali', 'ta-IN': 'Tamil', 'te-IN': 'Telugu', 'mr-IN': 'Marathi', 'gu-IN': 'Gujarati', 'kn-IN': 'Kannada', 'ml-IN': 'Malayalam', 'pa-IN': 'Punjabi', 'od-IN': 'Odia', 'ur-IN': 'Urdu' };
const docLangLabel = (c) => (DOC_LANG[c] ? `${DOC_LANG[c]} (${c})` : c);

const consentBox = (id, text) => {
  const cb = h('input', { type: 'checkbox', id, 'data-fid': id }); // never pre-checked
  return { cb, el: h('div', { class: 'consent' }, h('label', { for: id }, cb, ' ', text)) };
};
const errLine = (e) => h('p', { class: 'form-error', role: 'alert' }, e.message || 'Something went wrong.');
const pageChars = (n) => `${n} character${n === 1 ? '' : 's'}`;

/* ------------------------------------------------------------------ analysis (Sarvam Document AI) */

export function cloudAnalysisPanel(ctx) {
  const ai = ctx.snap.meta.aiProvider;
  if (!ai || !ai.features || !ai.features.documentAnalysis) {
    return h('p', { class: 'hint', 'data-fid': 'cloud-off' }, 'Cloud analysis is off (rules only). Everything above works without it, and local OCR needs no internet.');
  }
  if (!ctx.snap.can['document.add']) return null;
  return h('div', { class: 'cloud-box' },
    h('h4', {}, 'Optional: analyse a scan with Sarvam Document AI'),
    h('p', { class: 'hint' }, ai.cloudNotice),
    btn('Analyse with Sarvam…', () => analysisDialog(ctx), { fid: 'cloud-open' }));
}

function analysisDialog(ctx) {
  const ai = ctx.snap.meta.aiProvider;
  const body = h('div', {});
  const m = modal({ title: 'Analyse a document with Sarvam Document AI', body, wide: true });
  let jobId = null, state = 'form', timer = null, started = 0;
  const close = () => { clearTimeout(timer); m.close(); };
  m.dlg.addEventListener('close', () => {
    clearTimeout(timer);
    if (jobId && (state === 'running' || state === 'ready')) ctx.api('POST', `/api/ai/analyze/${jobId}/cancel`, {}).catch(() => {}); // abandon or discard; nothing was added
  });

  function showForm(error) {
    state = 'form'; jobId = null;
    const file = h('input', { type: 'file', accept: '.pdf,.png,.jpg,.jpeg', 'data-fid': 'cloud-file' });
    const sample = h('select', { 'data-fid': 'cloud-sample' }, [h('option', { value: '' }, 'None (use the file chosen above)'), ...(ai.sampleScans || []).map((s) => h('option', { value: s.id }, s.title))]);
    const langSel = h('select', { 'data-fid': 'cloud-lang' }, (ai.supportedDocumentLanguages || ['en-IN']).map((c) => h('option', { value: c, selected: c === 'en-IN' }, docLangLabel(c))));
    const { cb, el } = consentBox('cloud-consent', 'I understand that the selected file will be sent to Sarvam AI, an external service, for analysis. It is a synthetic or sample document and contains no real personal, patient or insurance data.');
    const start = btn('Send to Sarvam and analyse', onStart, { kind: 'primary', fid: 'cloud-start', disabled: true });
    const sync = () => { start.disabled = !(cb.checked && (file.files[0] || sample.value)); };
    [cb, file, sample].forEach((x) => x.addEventListener('change', sync));
    body.replaceChildren(
      h('p', { class: 'notice-inline', role: 'note' }, ai.cloudNotice),
      field('Choose a PDF, PNG or JPG', file, `Up to ${kb(ctx.snap.limits.maxUploadBytes)} and 10 pages. Ordinary upload above stays fully local.`),
      field('…or use a synthetic sample scan', sample),
      field('Language of the document', langSel, 'Sarvam can read many Indian languages. ClaimTrail’s own guidance panel supports English and Hindi only.'),
      el,
      error ? errLine(error) : null,
      h('div', { class: 'actions' }, start, btn('Cancel', close)));
    async function onStart() {
      start.disabled = true;
      try {
        const req = { externalProcessingConsent: cb.checked === true, language: langSel.value };
        if (file.files[0]) { req.name = file.files[0].name; req.dataBase64 = await readFileB64(file.files[0]); } else req.sampleScanId = sample.value;
        const v = await ctx.api('POST', '/api/ai/analyze', req);
        jobId = v.id; state = 'running'; started = Date.now();
        showRunning(v);
      } catch (e) { showForm(e); }
    }
  }

  function showRunning(v) {
    const secs = h('span', {}, '0');
    body.replaceChildren(
      h('p', { role: 'status', 'data-fid': 'cloud-running' }, `Sarvam is reading “${v.name}”… `, secs, ' s. This can take up to about a minute.'),
      h('div', { class: 'actions' }, btn('Cancel analysis', async () => { try { await ctx.api('POST', `/api/ai/analyze/${jobId}/cancel`, {}); } catch { /* already finished */ } state = 'cancelled'; close(); ctx.refresh('Analysis cancelled. Nothing was added.'); }, { fid: 'cloud-cancel' })));
    const tick = async () => {
      if (state !== 'running') return;
      secs.textContent = String(Math.round((Date.now() - started) / 1000));
      try {
        const j = await ctx.api('GET', `/api/ai/analyze/${jobId}`);
        if (state !== 'running') return;
        if (j.status === 'ready') { state = 'ready'; return showResult(j); }
        if (j.status === 'failed') { state = 'failed'; return showForm(Object.assign(new Error(j.error ? j.error.message : 'The analysis failed.'), {})); }
        if (j.status === 'cancelled' || j.status === 'discarded') { state = 'cancelled'; return close(); }
      } catch (e) { state = 'failed'; return showForm(e); }
      timer = setTimeout(tick, 1500);
    };
    timer = setTimeout(tick, 800);
  }

  function showResult(j) {
    const r = j.result;
    const fields = r.fields || [];
    body.replaceChildren(
      h('p', {}, chip('needs_review', 'Machine-read: verify against the original'), ' ', chip('info', 'Confidence: not supplied by the provider')),
      h('p', { class: 'notice-inline', role: 'note' }, r.notice),
      r.partial ? h('p', { class: 'form-error', role: 'alert' }, 'Partial result: some pages could not be processed and will appear as unreadable. Nothing was invented for them.') : null,
      h('h3', {}, `Extracted text for ${j.name}`),
      r.pages.map((p, i) => h('details', { open: i === 0 }, h('summary', {}, `Page ${p.n} (${pageChars(p.chars)})${p.readable ? '' : ' — little or no text'}`), h('pre', { class: 'source', tabindex: '0', 'aria-label': `Extracted text of page ${p.n}` }, p.text || '(no text returned for this page)'))),
      h('h3', {}, 'Values the rules found (each with its page and source line)'),
      fields.length
        ? table(['Field', 'Value', 'Source', 'Check'], fields.map((f) => row(['Field', 'Value', 'Source', 'Check'], [f.label, h('strong', {}, f.value), `p.${f.page}: ${f.excerpt}`, f.verify ? chip('needs_review', 'Verify against original') : chip('info', 'Check')])), { caption: 'Fields found in the extracted text', cls: 'stack' })
        : h('p', { class: 'hint' }, 'No standard fields were recognised. The page text can still be added as evidence.'),
      h('p', { class: 'hint' }, 'Adding this makes it machine-read evidence. It does not accept any match, clear any blocker or change the status: the deterministic checks re-run and a person still confirms the links.'),
      h('div', { class: 'actions' },
        btn('Add to packet as machine-read evidence', async () => {
          try { const out = await ctx.api('POST', `/api/ai/analyze/${jobId}/confirm`, {}); state = 'done'; close(); await ctx.refresh(`Added ${out.document.name} as machine-read evidence. Nothing was accepted automatically.`); } catch (e) { ctx.fail(e); }
        }, { kind: 'primary', fid: 'cloud-add' }),
        btn('Discard', async () => { try { await ctx.api('POST', `/api/ai/analyze/${jobId}/cancel`, {}); } catch { /* ignore */ } state = 'discarded'; close(); }, { fid: 'cloud-discard' })));
  }
  showForm();
}

/* ------------------------------------------------------------------ English / Hindi guidance */

export function guidancePanel(ctx) {
  const ai = ctx.snap.meta.aiProvider;
  const box = h('div', { 'aria-live': 'polite', 'data-fid': 'guidance-box' }, h('p', { class: 'muted' }, 'Loading guidance…'));
  const sel = h('select', { id: 'lang-select', 'data-fid': 'lang-select', onchange: () => { lang = sel.value; try { localStorage.setItem(LANG_KEY, lang); } catch { /* ignore */ } load(); } },
    [['en', 'English'], ['hi', 'हिन्दी (Hindi)']].map(([v, l]) => h('option', { value: v, selected: v === lang }, l)));

  async function load() {
    try {
      const g = await ctx.api('GET', `/api/guidance?lang=${encodeURIComponent(lang)}`);
      const hi = g.lang === 'hi';
      const L = (txt) => h('span', { lang: g.lang }, txt);
      const H = ['Requirement (original wording)', 'Status', 'What to do', 'Source'];
      box.replaceChildren(
        h('p', { class: 'notice-inline', role: 'note' }, h('span', { lang: g.lang }, g.disclaimer), hi ? h('span', { class: 'hint' }, ' ', g.disclaimerEn) : null),
        h('p', { class: 'next' }, h('strong', {}, hi ? 'अगला कदम / Next action: ' : 'Next action: '), L(g.nextAction.text), hi ? h('span', { class: 'hint' }, ` (Original: ${g.nextAction.original})`) : null),
        table(H, g.requirements.map((q) => row(H, [
          q.original,
          h('span', {}, L(q.statusText), hi ? h('span', { class: 'hint' }, ` (${q.statusOriginal})`) : null),
          h('span', {}, L(q.hint), hi ? h('span', { class: 'hint' }, ` — ${q.hintOriginal}`) : null),
          q.source ? `${q.source.docName}, p.${q.source.page}` : 'none',
        ])), { caption: 'Guidance per requirement', cls: 'stack' }),
        g.findings.length
          ? h('div', {}, h('h3', {}, hi ? 'खुले निष्कर्ष / Open findings' : 'Open findings'), h('ul', { class: 'plain' }, g.findings.map((f) => h('li', {},
            chip(f.blocking ? 'blocker' : 'review', f.code), ' ', L(f.text),
            h('p', { class: 'hint' }, `Original: ${f.original}`),
            f.cites.length ? h('p', { class: 'hint' }, 'Source: ', f.cites.map((c) => `${c.docName} p.${c.page}`).join('; ')) : h('p', { class: 'hint' }, 'No page cited: the required evidence is absent.')))))
          : h('p', { class: 'hint' }, 'No open findings.'),
        h('p', { class: 'hint' }, 'Built-in phrase map: no AI model, no network, works offline. Languages implemented: English and Hindi. IDs, amounts, dates, names and file names are always shown exactly as in the documents.'));
    } catch (e) { box.replaceChildren(errLine(e)); }
  }
  load();

  return h('section', { class: 'panel', 'aria-labelledby': 'h-guid' },
    h('h2', { id: 'h-guid' }, 'Guidance in your language / अपनी भाषा में सहायता'),
    field('Language / भाषा', sel, 'The original English wording is always shown next to the translation.'),
    box,
    ai && ai.features && ai.features.translation ? h('div', { class: 'cloud-box' },
      h('h4', {}, 'Optional: machine-translate the insurer request with Sarvam Translate'),
      h('p', { class: 'hint' }, 'Sends the insurer request text of this synthetic case to Sarvam AI (an external service). The built-in Hindi guidance above works without it.'),
      btn('Translate the request into Hindi…', () => translateDialog(ctx), { fid: 'translate-open' })) : null);
}

function translateDialog(ctx) {
  const body = h('div', {});
  const m = modal({ title: 'Translate the insurer request into Hindi (Sarvam Translate)', body, wide: true });
  const { cb, el } = consentBox('translate-consent', 'I understand the insurer request text of this synthetic case will be sent to Sarvam AI, an external service, to be translated.');
  const go = btn('Send and translate', async () => {
    go.disabled = true;
    body.querySelector('.result').replaceChildren(h('p', { role: 'status' }, 'Translating…'));
    try {
      const t = await ctx.api('POST', '/api/ai/translate', { externalProcessingConsent: cb.checked === true, target: 'hi-IN', scope: 'request_letter' });
      body.querySelector('.result').replaceChildren(
        h('p', { class: 'notice-inline', role: 'note' }, `Machine translation by ${t.provider}. It is explanatory help only, not legal or coverage advice. IDs, numbers, amounts and dates were checked and are unchanged.`),
        h('div', { class: 'cols2' },
          h('div', {}, h('h3', {}, 'Original (English): authoritative'), h('pre', { class: 'source', tabindex: '0', 'aria-label': 'Original request text' }, t.source)),
          h('div', {}, h('h3', {}, 'अनुवाद (Hindi): machine translation'), h('pre', { class: 'source', lang: 'hi', tabindex: '0', 'aria-label': 'Hindi machine translation' }, t.translated))));
    } catch (e) {
      body.querySelector('.result').replaceChildren(errLine(e), h('p', { class: 'hint' }, 'The original text is unchanged and the built-in Hindi guidance panel still works.'));
      go.disabled = !cb.checked;
    }
  }, { kind: 'primary', fid: 'translate-go', disabled: true });
  cb.addEventListener('change', () => { go.disabled = !cb.checked; });
  body.replaceChildren(
    h('p', { class: 'notice-inline', role: 'note' }, 'Only the insurer request text of this case can be translated here. Nothing else is sent.'),
    el, h('div', { class: 'actions' }, go, btn('Close', () => m.close())), h('div', { class: 'result' }));
}
