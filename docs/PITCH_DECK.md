# ClaimTrail — pitch deck (7 slides, copy-ready)

Track: Paytm Build for India AI Hackathon — Delhi, Track 2: AI-Powered Financial Journeys.
Rules for this deck: no unsourced statistics, no partner or pilot claims, no hosted URL. Every claim below is either shown live in the demo or marked as future.

---

## Slide 1 — ClaimTrail

**Every claim requirement mapped to evidence. Every intake finding traceable to its source.**

- Evidence & intake assurance for health-insurance reimbursement
- One shared evidence model for the claimant and the insurer/TPA intake reviewer
- Demo built on synthetic, fictional data

*Speaker note:* "We prepare documents and check intake completeness. We do not decide claims."

## Slide 2 — The problem

**Packets bounce for reasons nobody can trace.**

- A required report is missing, a scan is unreadable, a copy is duplicated, a total disagrees between two documents
- The claimant learns this late, through a generic request
- The reviewer re-checks the same pages by hand and writes the same message again
- Neither side can see *which page backs which requirement*

*Speaker note:* Keep this qualitative. We have no measured numbers and do not quote any.

## Slide 3 — What ClaimTrail does

**One case, two views, one correction loop.**

- **Claimant workspace:** each insurer requirement mapped to a document page, with status (matched, missing, unreadable, ambiguous, duplicate), a missing-items checklist, a packet manifest, and a draft follow-up
- **Intake QA console:** findings with stable reason codes, each citing a page or stating what is absent; accept/reject matches; resolve with a note; request corrections
- **Correction → resubmission** with a re-upload diff and preserved history

*Speaker note:* Show Slide 3 as a split screen: claimant table on the left, reviewer findings on the right, same case id.

## Slide 4 — Traceability you can click

**From finding to source page in one click.**

- Example: `FIELD_MISMATCH` — claimed ₹1,24,500 vs bill total ₹1,42,500 → cites `claim_form.txt p.1` and `hospital_final_bill.txt p.2`
- Results are `match`, `mismatch`, `not found`, `not comparable` or `needs review`. A discrepancy is a point to review, never a fraud label
- `REQ_MISSING` cites no page and says which evidence is absent
- Links without a valid page and excerpt cannot be accepted

*Speaker note:* Live demo here: open the page viewer and show the highlighted line.

## Slide 5 — Trust by design

**Deterministic code decides; proof gates every "submitted".**

- "Submitted", "Resubmitted" and "Acknowledged" are refused without an insurer reference **and** a proof file; "sent" alone does not count
- "Intake checks complete" means configured document checks passed. It is not a coverage decision
- Rules own transitions, comparisons, hashes, links and permissions. No model is called in this build; the UI says so
- Works offline; uploads never leave the process; reset deletes everything

*Speaker note:* Show the refused submission and the "Not complete" outcome panel for the mismatch that stays open.

## Slide 6 — What is real today

**Implemented, simulated, and future — stated plainly.**

| Implemented and tested | Simulated | Future |
|---|---|---|
| Two-sided workflow, lifecycle with proof gates, reason codes, exports, audit trail, reset, local offline OCR with confidence gating | Seeded "scanned" documents (pre-recorded text, for a repeatable demo), fictional receipts, synthetic dashboard figures, static queue rows, role switch | OCR, real authentication and tenancy, multi-case storage, optional model adapter for classification and wording only, insurer/TPA and payment-app integrations |

- Verified locally: automated unit/integration/HTTP tests, a real-process API smoke test and a Chromium walkthrough at desktop and mobile widths (results in `docs/TEST_REPORT.md`)

## Slide 7 — Where it fits and what's next

**A document-assurance layer inside AI-powered financial journeys.**

- Fits Track 2 as a journey step: *prepare → verify → resubmit* for a high-friction financial process
- Next: handwriting / multilingual OCR and an optional, schema-validated model adapter for classification and wording only; reviewer-configurable rule packs per insurer; a pilot with a real TPA under proper consent and data controls (none exists today)
- Success measures we would track in a pilot (not claimed today): first-pass completeness, repeat-request rate, blocker ageing, time-to-triage

*Speaker note:* End on the honesty line: "Everything you saw runs locally on fictional data; we've told you what is simulated."
