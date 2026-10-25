# ClaimTrail — product spec (MVP as built)

Track: Paytm Build for India AI Hackathon — Delhi, Track 2: AI-Powered Financial Journeys.
Status labels used below: **Implemented** (runs and is covered by tests), **Simulated** (fixture stands in for a real thing), **Future** (not built).

## 1. Problem and scope

Health-insurance reimbursement packets are often returned because a required document is absent, a scan is unreadable, a copy is duplicated, or numbers disagree between documents. Both sides lose time because nobody can see *which requirement is backed by which page* and *why a check failed*.

ClaimTrail gives the claimant and the insurer/TPA intake reviewer **one shared evidence model** with traceability from every requirement and every finding to a document page (or to a statement that evidence is absent).

**Non-goals (explicit):** coverage or claim decisions, medical/clinical judgement, fraud scoring or classification, payment, approval prediction, real insurer/Paytm integration. No UI label may imply any of these.

## 2. Users and jobs

| User | Job | Key surfaces |
|---|---|---|
| Claimant (or helper) | Know exactly what is missing/weak before submitting; keep proof of what was sent | Requirements table, readiness, exports, follow-up draft, proof dialogs |
| Intake reviewer (insurer/TPA) | Triage a packet fast, with each finding traceable; request corrections; confirm completeness | Queue, findings, comparison table, accept/reject, resolve-with-note, outcome panel, report, dashboard |

## 3. Shared data model (Implemented)

One case record feeds both views: `case`, `requirements[]`, `documents[]` (pages, SHA-256, classification, extracted fields with page + excerpt, delivery status, version history), `links[]` (requirement → doc/page/excerpt/confidence/decision), `ledger` (findings with history), `events[]` (audit trail), `drafts[]`, `submissions[]` (reference + proof hash). The server derives all statuses from this state, so claimant and reviewer see identical data (`GET /api/state` returns the same case/evidence/findings to both; only `can`, `transitions` and navigation differ by role; asserted in tests).

## 4. Functional requirements and status

### A. Claimant workspace
| Requirement | Status |
|---|---|
| Open the seeded fictional case | Implemented |
| Editable requirement checklist (label, category, required flag, add/remove); candidate extraction from the request letter, each confirmed by the user | Implemented (rules only) |
| Add files (txt, md, csv, json, pdf, png, jpg ≤ 1 MB) or fictional samples; replace with a diff | Implemented |
| Per-requirement suggested page match with confidence + explanation | Implemented |
| Visible states: matched, missing, unreadable, ambiguous, needs review, possible duplicate | Implemented |
| Export packet manifest (JSON/MD) and missing-items checklist (MD); exports never change status | Implemented |
| Follow-up message draft for human review (never sent) | Implemented |
| OCR of images/PDFs | **Implemented, optional**: local Tesseract + Poppler, auto-detected, confidence-gated (reject < 50%, verify < 75%). Falls back to *unreadable* when tools are absent. Not an AI model |
| Live AI model / cloud OCR | **Not implemented** (deliberately: default privacy rule is that documents never leave the machine) |

### B. Intake QA console
| Requirement | Status |
|---|---|
| Queue with status, open blockers, next action, `DEMO DATA` label | Implemented (1 live case + 6 static placeholder rows) |
| Inspect requirements, documents, source pages, matches, findings | Implemented |
| Flag missing categories, unreadable pages, exact/likely duplicates, cross-document discrepancies with stable reason codes | Implemented |
| Comparison results `match`, `mismatch`, `not found`, `not comparable`, `needs review`; discrepancy never called fraud | Implemented |
| Accept/reject match (reject needs reason); resolve finding with required note; reopen; re-run checks with diff; correction-request draft | Implemented |
| Add corrected evidence, re-run, keep resolved vs unresolved history | Implemented |
| Operations dashboard: first-pass completeness, repeat/reopen rate, blocker ageing, time-to-triage — labelled synthetic | Implemented (**Simulated** data) |

### C. Shared state and audit
| Requirement | Status |
|---|---|
| Lifecycle Draft → Preparing → Ready for review → Submitted → Intake review → Action required → Resubmitted → Intake checks complete | Implemented |
| *Submitted*/*Resubmitted*/per-document *Acknowledged* blocked without reference + proof file | Implemented |
| Append-only event history within the demo; not described as immutable | Implemented |
| Reset restores the exact fixture | Implemented |

## 5. Lifecycle and guards

| From → To | Actor | Guards |
|---|---|---|
| Draft → Preparing | claimant | — |
| Preparing → Ready for review | claimant | readiness: no missing *required* evidence, no evidence link without a valid source |
| Ready for review → Preparing | claimant | — |
| Ready for review → Submitted | claimant | readiness + **proof** (reference 6–40 chars, unused; proof file ≤ 200 KB) |
| Submitted → Intake review | reviewer | — |
| Intake review → Action required | reviewer | ≥ 1 open finding; creates a correction-request draft |
| Action required → Resubmitted | claimant | **proof** (new reference) + new/replaced/withdrawn evidence since the request |
| Resubmitted → Action required | reviewer | ≥ 1 open finding |
| Intake review / Resubmitted → Intake checks complete | reviewer | no open blocker/review findings **and** every required match confirmed by the reviewer |

"Intake checks complete" means configured document checks passed. It is not a coverage decision (stated in the UI, report and drafts).
After submission the claimant's packet is frozen; reviewers can add intake evidence only in review phases.

## 6. Reason codes (stable)

| Code | Severity | Raised when |
|---|---|---|
| `REQ_MISSING` | blocker | A required requirement has no linked/classified document. Cites no page; states the evidence is absent |
| `DOC_PAGE_UNREADABLE` | blocker | A page has < 40 characters or < 50 % letters/digits; images/PDFs have no text layer |
| `FIELD_MISMATCH` | blocker | Same field differs across two matched documents (e.g., claimed amount vs bill total) |
| `PROVENANCE_MISSING` | blocker, not overridable | A live link points to a missing document/page or has no excerpt |
| `REQ_AMBIGUOUS` | review | Different readable documents compete for one requirement |
| `LINK_LOW_CONFIDENCE` | review | Match confidence < 75 % |
| `DUP_EXACT` / `DUP_LIKELY` | review | Same SHA-256 / ≥ 85 % text-token overlap |
| `FIELD_NEEDS_REVIEW` | review | Similar but not identical (e.g., "Aarav Mehta" vs "Aarav K Mehta") |
| `FIELD_NOT_FOUND` / `FIELD_NOT_COMPARABLE` | info | Field absent / document unreadable or unparsable |
| `DELIVERY_PROOF_MISSING` | info | Item marked "sent" without reference + proof; stays *not acknowledged* |

Every finding carries evidence citations (document, page, excerpt) or, for `REQ_MISSING`, an explanation of what is absent. Findings persist with history; when evidence changes and the issue disappears they auto-resolve ("evidence changed"); reviewer overrides require a note and are listed in the report.

## 7. Roles and permissions (Implemented, demo-grade)

Enforced in `src/lifecycle.js` and checked by the store on every request (not only in the UI).

| Action | Claimant | Reviewer |
|---|---|---|
| View case/evidence/findings/audit | ✓ | ✓ |
| Edit requirements, extract candidates | ✓ (while Draft/Preparing/Action required) | ✗ |
| Add / replace evidence, set delivery, withdraw a document | ✓ while editable | reviewer may add intake evidence in review phases |
| Accept/reject/choose a match | ✓ (a claimant confirmation never satisfies completion) | ✓ |
| Accept all clean matches, resolve/reopen finding, re-run checks, correction draft | ✗ | ✓ |
| Follow-up draft | ✓ | ✗ |
| Queue, dashboard, intake report | ✗ | ✓ |
| Exports, reset | ✓ | ✓ |

Real authentication, tenant isolation, session handling and rate limiting are **Future**.

## 8. AI and fallback policy

- Core demo needs no key and no network (verified by the static check: no outbound network code in `src/`).
- `src/ai.js` is the only boundary where a model could plug in (classification, candidate extraction, draft wording). It validates the shape of any output; ambiguous results would need person confirmation. **No live model is wired up.** Mode shown in UI/API: `deterministic-rules` (`live: false`).
- Deterministic code owns state transitions, comparisons, duplicate hashes, evidence links and permissions.

## 9. Security, privacy, accessibility

- Synthetic data only; default behaviour never transmits uploads anywhere.
- Uploads validated for type, size (1 MB), encoding, name and magic bytes; actionable error messages.
- No `innerHTML` in the browser code (static check), strict CSP, `X-Content-Type-Options`, localhost bind, JSON-only writes, no CORS.
- Logs: method/path/status only. Events: ids, codes and short hashes.
- Semantic HTML, skip link, labelled controls, visible focus, text + icon on every status chip, stacked tables at ≤ 820 px, reduced-motion respected. Automated checks cover names/labels, overflow at 390 px and focus visibility; **no screen-reader testing was done**.

## 10. Assumptions

- One live case is enough to prove the shared model; multi-case storage is future work.
- Insurer request letters are numbered lists in English; classification rules target typical Indian hospital/pharmacy/lab headings.
- Amounts are compared numerically after removing separators (Indian grouping supported); currency symbols are ignored.
- Dates are `YYYY-MM-DD` or `DD/MM/YYYY`.
- Proof files are accepted as evidence of the *user's own record*; ClaimTrail cannot verify with an insurer.
