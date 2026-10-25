# ClaimTrail — Evidence & Intake Assurance

> Every claim requirement mapped to evidence. Every intake finding traceable to its source.

A two-sided demo for **Paytm Build for India AI Hackathon — Delhi, Track 2: AI-Powered Financial Journeys**.
One shared case and evidence model serves:

1. **Claimant workspace**: prepare an evidence-linked health-insurance reimbursement packet.
2. **Insurer / TPA intake QA console**: check completeness, readability, duplicates and cross-document consistency, then drive a correction → resubmission loop.

**ClaimTrail is a document-preparation and intake-QA assistant. It is not a claim adjudication engine, coverage decision, fraud classifier or approval predictor.** "Intake checks complete" only means the configured document checks passed.

**DEMO DATA ONLY.** Every person, provider, claim ID and amount is fictional. There is no real insurer, Paytm or payment integration, no customer pilot, no hosted URL and no live AI model.

---

## Quick start

Prerequisites: **Node.js 20 or newer** (developed and tested on Node 22). No `npm install` is needed: the app has **zero runtime dependencies**, needs no API key, Docker, database or internet connection.

```bash
cd claimtrail
npm start            # http://127.0.0.1:3000
```

Open <http://127.0.0.1:3000>. Use the **Claimant / Intake reviewer** switch in the top bar. (It is a demo switch, not a login.)

| Command | What it does |
|---|---|
| `npm start` | Run the app (`PORT`, `HOST`, `CLAIMTRAIL_DATA` env vars are optional) |
| `npm test` | 63 unit + integration + HTTP tests (`node --test`), including 10 OCR tests that skip with a printed reason if Tesseract is missing |
| `npm run check` | Static quality gate: syntax, no network code, no `innerHTML`, no secrets, honest wording, fixture determinism, docs present |
| `npm run build` | Same as `check`. There is nothing to bundle: the app is plain Node + browser ES modules, so the "production build" is this gate. Deploy by running `npm start` |
| `npm run smoke` | Starts the real server process and walks the full API loop, including a server restart |
| `npm run ui-smoke` | Chromium (Playwright) walkthrough at desktop and 390px mobile. Needs Playwright, which is **not** a dependency of this repo; the script prints `NOT RUN` and exits 2 if it is missing |
| `python3 scripts/build-deck.py` | Rebuilds `docs/ClaimTrail_pitch.pptx` (7 slides) from `docs/PITCH_DECK.md`. Optional; needs `pip install python-pptx` |
| `npm run reset` | Deletes the saved demo state (`data/state.json`); the next start re-seeds the fixture |

**Reset from the UI:** footer → *Reset demo data*. It deletes uploads, proofs, notes, drafts and history and restores the original fixture exactly (covered by tests).

Demo credentials: none. Roles are a switch in the UI and an `X-Role` header in the API.

## The 3-minute judge path

A collapsible *Guided demo path* sits at the top of both views. Full script with expected results: [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md).

1. **Claimant**: the seeded case shows a missing lab report, an unreadable pharmacy scan, a possible duplicate and a claimed-amount mismatch. *Mark packet ready* is refused with the reason.
2. Add the sample lab report → mark ready → *Record submission*. It is refused without a reference and proof file, then accepted with the fictional sample receipt.
3. **Intake reviewer**: queue → open case → *Start intake review*; every finding cites a document page or says what is absent. Accept clean matches, resolve the duplicate with a note (empty note refused), *Request corrections* (draft only, nothing is sent).
4. **Claimant**: add the corrected pharmacy bill (re-upload diff shown) and ID, record the resubmission with proof.
5. **Reviewer**: *Re-run checks*. The claimed-amount mismatch **stays open**; *Mark intake checks complete* is refused and the outcome panel and report say why. Add the sample corrected claim form to clear it and complete.

## What is implemented, simulated, and future work

**Implemented (works, tested):**

- Seeded fictional case with 7 requirements and 7 documents covering: one clean bill match, one missing required report, one unreadable page, one possible duplicate, one cross-document mismatch, one item acknowledged **with** proof, one item "sent" **without** proof.
- Editable requirement checklist; deterministic rules extract candidate requirements from the request letter (you confirm each).
- Deterministic document classification, field extraction (name, policy no., claim ref, dates, amounts), page-level readability check, exact (SHA-256) and likely (text similarity) duplicate detection.
- Requirement → document page links with excerpt, confidence and explanation. Links without a valid page/excerpt cannot be accepted and become a non-overridable blocker.
- Comparison results `match` / `mismatch` / `not found` / `not comparable` / `needs review`, and stable reason codes (`REQ_MISSING`, `DOC_PAGE_UNREADABLE`, `DUP_LIKELY`, `DUP_EXACT`, `FIELD_MISMATCH`, `FIELD_NEEDS_REVIEW`, `FIELD_NOT_FOUND`, `FIELD_NOT_COMPARABLE`, `LINK_LOW_CONFIDENCE`, `REQ_AMBIGUOUS`, `PROVENANCE_MISSING`, `DELIVERY_PROOF_MISSING`).
- Reviewer actions: accept/reject matches (reject needs a reason), resolve a finding (note required), reopen, re-run checks with a new/resolved/still-open diff, correction-request draft.
- Lifecycle Draft → Preparing → Ready for review → Submitted → Intake review → Action required → Resubmitted → Intake checks complete, enforced by code. *Submitted* and *Resubmitted* require an insurer reference **and** a proof file; a reference can be used once; *Resubmitted* also requires new evidence since the correction request; *Acknowledged* (per document) requires a reference and proof file.
- Re-upload with a diff (pages, readable pages, detected type, changed fields); old versions kept in history.
- Exports (packet manifest JSON/Markdown, missing-items checklist, intake report) that state they are **not a submission**. Message drafts are text only, labelled *not sent*.
- Audit trail (append-only inside the running process), role-specific navigation and server-side permission checks, upload validation, reset.
- Operations dashboard (four tiles) computed from clearly labelled **synthetic** rows, plus live counts for the demo case.

- **Local OCR (optional, offline):** uploaded `.png/.jpg/.pdf` files are read with locally installed Tesseract (images, scanned PDF pages) and `pdftotext` (PDF text layer). It is software OCR, **not an AI model**; nothing leaves the machine. Every OCR page records engine, mean confidence and method. Below 50% confidence the text is discarded and the page counts as unreadable; 50-74% is kept but flagged *verify*, and a difference found in such a page is shown as *needs review*, never as a hard mismatch. If Tesseract is missing (or `CLAIMTRAIL_OCR=off`) the app degrades to the old behaviour: images/PDFs count as unreadable, with a stated reason.

**Simulated (not real):**

- The **seeded** "scanned" pharmacy bill and photo ID are pre-recorded text fixtures (so the demo is identical on every machine). Real OCR is exercised by *uploading* the files in `samples/` (see below).
- The six extra queue rows are static placeholders and cannot be opened. Only one case is live.
- Submission and acknowledgement "receipts" are fictional files; nothing is sent anywhere.
- Roles are a UI/header switch, not authentication.
- Dashboard figures are invented fixture data, not measurements.

**Not implemented / future work:** real authentication, tenant isolation, encryption at rest, rate limiting, audit-log tamper-proofing; handwriting, non-English and table-aware OCR, and image deskew/pre-processing; multi-case storage; live-model adapter (the adapter boundary and output validators exist, but **no model is called**); real insurer/TPA or Paytm integrations; localisation; a screen-reader audit.

**AI honesty:** every result is produced by deterministic rules and fixed templates. The UI and API report `deterministic-rules` / `no AI model used`. Uploaded content never leaves the process.

## Real OCR demo (optional, needs Tesseract + Poppler)

```bash
sudo apt-get install tesseract-ocr poppler-utils   # macOS: brew install tesseract poppler
```

The app auto-detects them (the upload hint says "read with local OCR (tesseract x.y)" when found). Then try the synthetic scans in `samples/`:

| File | What happens |
|---|---|
| `samples/lab_report_scan.pdf` | Image-only PDF: rasterised and OCR-read; satisfies the missing lab-report requirement |
| `samples/pharmacy_bill_scan_corrected.png` | High-confidence read (~93% in our run). Use **Replace** on `pharmacy_bill_scan.png` to see the re-upload diff go 0 → 1 readable pages |
| `samples/poor_scan_unreadable.png` | Blurred/noisy: confidence far below 50%, text discarded, page stays **unreadable** with the reason shown |

Known OCR limits seen in testing: the rupee sign "₹" was read as "%" in the clean sample, which is why the viewer tells reviewers to verify amounts against the original. OCR runs synchronously on the server (about 1-3 s per page, capped at 10 pages/doc). Regenerate the samples with `python3 scripts/make-sample-scans.py` (needs Pillow).

## Architecture

```
src/engine.js      pure rules: classify, extract, duplicates, link suggestion, requirement status, comparisons, findings
src/lifecycle.js   states, transitions + guards, role/action permission table
src/store.js       single shared case model; atomic mutations (rollback on error); append-only event log; persistence
src/fixtures.js    deterministic synthetic case + sample documents; seed replays normal store operations
src/ocr.js         optional local OCR adapter (tesseract/pdftotext/pdftoppm only, no shell, no network)
src/ai.js          adapter boundary + output validators (deterministic provider only)
src/drafts.js      fixed message templates (cannot send)
src/exporters.js   manifest, missing-items checklist, intake report
src/dashboard.js   synthetic-metric tiles
src/server.js      zero-dependency HTTP API + static files, strict CSP, localhost bind
public/            browser ES modules, DOM built with textContent only (no innerHTML)
test/              node:test suites (engine, store, server)
scripts/           check, smoke, ui-smoke, reset
data/state.json    local persistence (git-ignored)
```

Key design rules: deterministic code owns state transitions, comparisons, hashes, evidence links and permissions; failed requests leave state untouched; the server binds to `127.0.0.1` by default, sends no CORS headers and requires a JSON content type on writes.

## Privacy and safety notes

- Synthetic data only. Do not upload real health documents to this demo.
- Persistence is a plain local JSON file (not encrypted, not immutable). The audit trail is append-only in the running process only. It is **not** cryptographically tamper-proof.
- Server logs contain only method, path and status (verified by the smoke test). Events store ids, codes and short hashes, not document text.
- Uploads: allowed `.txt .md .csv .json .pdf .png .jpg .jpeg`, up to 1 MB each; file names are sanitised; magic bytes are checked for PDF/PNG/JPEG.

## Known limitations

See [`BUILD_STATUS.md`](BUILD_STATUS.md) and [`docs/TEST_REPORT.md`](docs/TEST_REPORT.md) for exact results and gaps. In short: rules are tuned for English hospital-style fixtures, only one case is live, browser automation ran on Chromium only, and no screen-reader or real-document testing was done.

## Docs

[`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md) · [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md) · [`docs/PITCH_DECK.md`](docs/PITCH_DECK.md) (+ generated `docs/ClaimTrail_pitch.pptx`) · [`docs/TEST_REPORT.md`](docs/TEST_REPORT.md) · [`BUILD_STATUS.md`](BUILD_STATUS.md)
