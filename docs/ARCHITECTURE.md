# Architecture

```
Browser (ES modules, textContent only, strict CSP)
   │  all calls via apiUrl() → /api/* only
   ▼
src/server.js  — roles (header, demo only), exact-origin CORS, health, body limits
   ├─ store.js       shared state, atomic mutations, append-only events, JSON persistence
   ├─ engine.js      deterministic classification / extraction / comparison / reason codes (owns state)
   ├─ lifecycle.js   proof-gated transitions
   ├─ ocr.js         optional local Tesseract/Poppler (no network)
   ├─ analysis.js    consent-gated preview jobs (in memory, TTL, caps, budget)
   │    └─ providers/sarvam.js   the ONLY module that touches the network (api.sarvam.ai)
   ├─ i18n.js        EN/HI phrase maps, invariance check
   ├─ config.js      env → config (AI_PROVIDER fail-safe, FRONTEND_ORIGINS, HOST/PORT)
   └─ exporters.js   manifest/report with truthful analysisMode
```
Principles: rules own state; model/OCR output is evidence to verify, never a decision; every extracted value carries page + excerpt provenance; the network boundary is enforced by `npm run check`.

Frontend hosting: `public/` served directly (monolith) or built to `dist/` with a generated `config.js` and CSP `connect-src 'self' <api origin>`.
