# ClaimTrail — Test report

Last updated after adding local OCR. Run date: 2026-10-24 · Node v22.22.0 · Linux · Chromium via Playwright (pre-installed in the build container).
Every result below comes from a command run in this session. Nothing is reported as passed unless it ran.

## Results summary

| Command | Result | Notes |
|---|---|---|
| `npm test` | **63 / 63 pass**, 0 fail, 0 skipped | engine, store, HTTP and OCR suites (10 OCR tests) |
| `CLAIMTRAIL_OCR=off npm test` | **58 pass, 0 fail, 5 skipped** | The 5 skips are the tests that need real OCR; shows graceful degradation without Tesseract |
| `npm run check` (= `npm run build`) | **14 / 14 pass** | Includes a new step proving `src/ocr.js` only spawns `tesseract`/`pdftotext`/`pdftoppm`, with `shell:false` |
| `npm run smoke` | **17 / 17 pass** | Real server process, full API loop, real restart, log inspected for document text |
| `npm run ui-smoke` | **25 / 25 pass** | Chromium at desktop and 390 px mobile; new step uploads a real clean and a degraded scan through the UI; zero console errors, page errors, failed requests or 5xx |
| Ad-hoc red-team probe | **19 / 19 pass** | See below. Script was a throwaway and is not part of the repo |
| `python3 scripts/build-deck.py` | wrote 7 slides | Rendered to PDF with LibreOffice and inspected visually: no overflow |

## What is not tested

- **No linter or type checker was run.** The project is plain JavaScript with no ESLint/TypeScript configured; `check` only verifies syntax and custom rules.
- **UI automation ran on Chromium only** (no Firefox/WebKit, no real phone). The 390 px result is an emulated viewport.
- **No screen-reader testing.** Keyboard order, focus ring, accessible names and non-colour status text are automated; assistive-tech behaviour is untested.
- **No real documents.** Rules are tuned to the English hospital-style fixtures. OCR was tested only on 3 synthetic scans rendered by us from the fixture text (one clean PNG, one image-only PDF, one deliberately degraded PNG) plus two corrupted files. Real phone photos, skew, stamps, handwriting, Hindi/regional scripts and multi-page real PDFs are untested.
- **OCR accuracy is not measured.** We have one observation, not a benchmark: on the clean PNG mean confidence was ~93% yet "₹" was read as "%". The confidence thresholds (reject < 50, verify < 75) are reasonable defaults, not tuned values.
- **OCR tests need Tesseract 5 + Poppler.** Present in the build container (tesseract 5.3.4); on a machine without them those 5 tests skip and the app falls back to "unreadable".
- **OCR runs synchronously** in the server request (about 1-3 s per page; capped at 10 pages per document); not load-tested.
- **No load, concurrency or multi-user testing.** One process, one case, in-memory state with a JSON file.
- **No AI model was ever called** (OCR is classical software, not a model), so there is no model accuracy result of any kind.
- The `ui-smoke` script needs Playwright, which is not a repo dependency. It prints `NOT RUN` (exit 2) when absent.

## Required test areas → where covered

| Required area | Test (file `test/`) |
|---|---|
| Source provenance | `field extraction records page and source excerpt`; `provenance: accepted matches need a valid page and excerpt…` |
| Missing evidence blocks readiness | `missing required evidence blocks readiness; adding it unblocks` |
| No Submitted/Acknowledged without proof | `Submitted is refused without proof…`; `Acknowledged needs a reference and a proof file…`; HTTP `Submitted is refused over HTTP without proof…` |
| Duplicate detection | `duplicate detection: exact hash, likely text…`; `exact duplicate upload… DUP_EXACT` |
| Mismatched fields | `cross-document mismatch cites both pages, is never called fraud…` |
| Unreadable scan | `unreadable scan is flagged; a real PNG upload counts as unreadable` |
| Override requires a note | `reviewer override requires a note…` |
| Re-upload diff | `re-upload diff reports changed fields…` |
| Reset | `reset restores the exact original fixture…`; HTTP `reset over HTTP restores the fixture` |
| Empty/error states | `empty states…`; `upload errors are actionable…` |
| Role-specific access | `role-specific access is enforced by the store…`; HTTP `role-specific routes…` |

## Red-team probe (HTTP surface, 19 checks, all passed)

Path traversal (plain, `%2f`, `%2e`) refused · missing role → 401 · unknown role and `__proto__` role refused · claimant cannot resolve findings (403) · malformed JSON → 400 · wrong content type refused · `__proto__` in JSON body causes no crash and no pollution · 4 MB body → 413 and the server stays up · submission without proof refused · `../../evil.txt` upload name handled without a 5xx · server log contains no document text.
(A twentieth line in the script, "CSP present", was a placeholder and is excluded; CSP is covered by the `static UI is served with a strict CSP` test.)

## Acceptance gates

| # | Gate | Status |
|---|---|---|
| 1 | Clean install | **Pass** — no install step; zero dependencies |
| 2 | One-command start | **Pass** — `npm start` |
| 3 | Shared data across views | **Pass** — smoke + UI smoke |
| 4 | Judge path ≤ 3 min | **Not timed with a real judge.** The scripted path has ~12 clicks; the UI smoke walks it in seconds |
| 5 | Accepted matches have valid source | **Pass** — unit + HTTP |
| 6 | Unsupported Submitted/Acknowledged refused | **Pass** |
| 7 | Intentional failure stays unresolved with reason | **Pass** — `FIELD_MISMATCH` |
| 8 | No approval/fraud/live-integration wording | **Pass** — enforced by `check` wording scan |
| 9 | Responsive + keyboard | **Pass** for automated checks; manual assistive-tech untested |
| 10 | All runnable tests pass | **Pass** (see table) |
| 11 | README/demo script match implementation | **Pass** — walked via ui-smoke; re-read after final edits |
| 12 | Honest final report | See `BUILD_STATUS.md` |
