# ClaimTrail — Build status

**Date:** 2026-10-25 · **State:** working demo, all runnable checks pass · **Data:** synthetic only

## Run it

```bash
cd claimtrail && npm start      # http://127.0.0.1:3000  (no install needed; Node >= 20)
```

## Command results (this session)

| Command | Result |
|---|---|
| `npm test` | 139/139 pass; with `CLAIMTRAIL_OCR=off` 134 pass + 5 skipped |
| `npm run check` | 15/15 pass (`npm run build` = check + build:dist) |
| `npm run smoke` | 17/17 pass |
| `npm run ui-smoke` | 25/25 pass (Chromium, desktop + 390 px, includes real OCR upload) |
| `npm run ui-smoke:split` | 25/25 pass (dist on one origin, API on another); fails as intended with a wrong `FRONTEND_ORIGINS` |
| Live Sarvam smoke / GitHub Actions run / Render deploy / Vercel deploy | **NOT RUN** |
| Red-team HTTP probe (throwaway script) | 19/19 pass |
| `python3 scripts/build-deck.py` | `docs/ClaimTrail_pitch.pptx`, 7 slides, visually checked |

## Files

`src/` (ocr, engine, lifecycle, store, fixtures, ai adapter, drafts, exporters, dashboard, server) · `public/` (UI) · `test/` (4 suites) · `scripts/` (check, smoke, ui-smoke, reset, build-deck, make-sample-scans) · `samples/` (3 synthetic scans) · `README.md` · `docs/` (PRODUCT_SPEC, DEMO_SCRIPT, PITCH_DECK, TEST_REPORT, ClaimTrail_pitch.pptx, screenshots/)

## Assumptions

- Kept the existing zero-dependency Node + browser-ES-module stack found in the workspace instead of the suggested TypeScript stack; it already worked and is the most reliable one-command run. Consequence: no type checker.
- "Build" = the static `check` gate; nothing is bundled.
- Roles are a header/UI switch, not authentication.

## Known gaps (unresolved)

1. No linter or type checker.
2. Browser testing: Chromium only; no real device; no screen-reader pass.
3. OCR is optional and local (Tesseract + Poppler). Without them images/PDFs count as unreadable. Tested only on 3 synthetic scans; accuracy not benchmarked (it misread "₹" as "%" once). The *seeded* "scanned" fixtures remain pre-recorded text on purpose, for a deterministic demo.
4. No AI model is called. The adapter boundary and validators exist but are unused. A cloud/model adapter was deliberately not added: it would break the default "documents never leave the machine" rule and needs a key.
5. Only one case is live; six queue rows are static placeholders.
6. The 3-minute judge path was scripted and automated but not timed with a human.
7. No hosted URL exists. Deploy = run `npm start` on any Node host.

## Next manual step

Rehearse `docs/DEMO_SCRIPT.md` once end to end yourself with a timer, then open `docs/ClaimTrail_pitch.pptx` and add your team name and the demo screenshots from `docs/screenshots/`.
