'use strict';
/**
 * OPT-IN live check of the real Sarvam Document AI API. Never runs in CI.
 *   SARVAM_API_KEY=... node scripts/sarvam-smoke.js --i-consent-to-send-synthetic-sample
 * Sends ONLY the synthetic samples/pharmacy_bill_scan_corrected.png (paid call). Prints the response STRUCTURE (types, no text),
 * so the per-page result shape - which Sarvam's reference does not document - can be confirmed. Prints no key and no content.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createSarvamProvider, describeShape } = require('../src/providers/sarvam');

(async () => {
  if (!process.argv.includes('--i-consent-to-send-synthetic-sample')) { console.log('sarvam-smoke: NOT RUN (pass --i-consent-to-send-synthetic-sample; this sends a synthetic sample file to api.sarvam.ai).'); process.exit(2); }
  if (!process.env.SARVAM_API_KEY) { console.log('sarvam-smoke: NOT RUN (SARVAM_API_KEY is not set).'); process.exit(2); }
  const provider = createSarvamProvider({ apiKey: process.env.SARVAM_API_KEY });
  const bytes = new Uint8Array(fs.readFileSync(path.join(__dirname, '..', 'samples', 'pharmacy_bill_scan_corrected.png')));
  try {
    const r = await provider.digitise({ name: 'pharmacy_bill_scan_corrected.png', bytes, language: 'en-IN', onRaw: (raw) => console.log('raw results structure:', JSON.stringify(describeShape(raw))) });
    console.log(`sarvam-smoke: PASS. ${r.pages.length} page(s); characters per page: ${r.pages.map((p) => p.text.length).join(', ')}; partial=${r.partial}`);
  } catch (e) { console.log(`sarvam-smoke: FAIL (${e.code || 'ERROR'}): ${e.message}`); process.exit(1); }
})();
