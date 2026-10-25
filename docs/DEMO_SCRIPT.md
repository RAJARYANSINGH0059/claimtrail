# ClaimTrail demo script (about 3 minutes)

Start: `npm start`, open <http://127.0.0.1:3000>. If you have already clicked around, use footer → **Reset demo data** first.
Everything below is synthetic; nothing is sent to anyone. The same steps are in the in-app *Guided demo path*.

**Say first (10 s):** "ClaimTrail prepares claim documents and checks intake completeness. It does not decide claims or detect fraud. Both sides share one evidence model."

## Part 1 — Claimant (≈70 s)

| # | Do | Expect |
|---|---|---|
| 1 | Open the page as **Claimant**. Scroll to *Requirements and evidence*. | 7 requirements. Statuses: Matched ×5 (one shows *Possible duplicate*), **Unreadable** (pharmacy), **Missing** (lab report). Each row names a document page. |
| 2 | Click the `claim_form.txt p.1` button. | Page text with the cited line highlighted (provenance). Close it. |
| 3 | Click **Mark packet ready for review**. | Refused: red banner "Missing required evidence: Diagnostic / laboratory reports…". Status stays *Preparing*. |
| 4 | Under *Add evidence*, click **Diagnostic / lab report**. | Requirement becomes Matched; readiness lists only a warning (pharmacy unreadable). |
| 5 | Click **Export missing-items checklist (Markdown)** and **Draft follow-up message**. | A download that says "not a submission"; a draft marked **DRAFT — not sent**. Status unchanged. |
| 6 | Click **Mark packet ready for review**, then **Record submission (proof required)**, then **Record** with nothing entered. | Refused: reference/proof required. Status stays *Ready for review*. |
| 7 | Click **Use a fictional sample reference and receipt (demo)** → **Record**. | Status *Submitted (proof on file)*; a submission record with reference `SUB-DEMO-0001` and the proof file hash. |

Also visible in *Documents*: `cancelled_cheque.txt` = **Acknowledged, proof on file**; `photo_id.txt` = **Sent, no proof** (counted as not acknowledged).

## Part 2 — Intake reviewer (≈70 s)

| # | Do | Expect |
|---|---|---|
| 8 | Click **Intake reviewer** (top bar). Queue shows **DEMO DATA**. Click **Open case**, then **Start intake review**. | Status *Intake review*. Queue note: only the first row is live; the rest are static. |
| 9 | Read *Findings*. | `DOC_PAGE_UNREADABLE` (pharmacy scan p.1), `FIELD_MISMATCH` (claimed ₹1,24,500 vs bill ₹1,42,500, cites `claim_form.txt p.1` and `hospital_final_bill.txt p.2`), `DUP_LIKELY` (discharge summary vs copy), `FIELD_NEEDS_REVIEW` (name "Aarav Mehta" vs "Aarav K Mehta" on the ID). Wording says "documentation inconsistency", never fraud. |
| 10 | Click **Accept all clean suggested matches**. | Matches show "accepted by reviewer"; unreadable/low-confidence items are skipped. |
| 11 | On `DUP_LIKELY` click **Resolve with note** → **Resolve finding** with an empty note. | Refused: note needs at least 5 characters. Then type a note → resolved; override and note appear in the finding history. |
| 12 | Click **Request corrections (draft only, nothing is sent)**. | Status *Action required*; a correction-request draft is shown, labelled not sent and "not a coverage decision". |

## Part 3 — Correction loop (≈40 s)

| # | Do | Expect |
|---|---|---|
| 13 | Switch to **Claimant**. | A callout shows the reviewer's request. |
| 14 | Add **Readable pharmacy bill** and **Photo ID with matching full name**. Open *Re-upload diff* on the pharmacy bill. | "readable pages: 0 → 1"; the old scan is kept under *History*. |
| 15 | **Record resubmission (proof required)** → sample reference/receipt → **Record**. (Without new evidence this is refused.) | Status *Resubmitted (proof on file)*. |
| 16 | Switch to **Intake reviewer** → *Case review* → **Re-run checks** → **Accept all clean suggested matches**. | "1 blocking": the `FIELD_MISMATCH` **is still open** (the claimant did not correct the claim form). |
| 17 | Click **Mark intake checks complete**. | Refused with the reason `FIELD_MISMATCH`. The *Intake outcome* panel says **Not complete** and lists the blocker with its two page citations. |
| 18 | Add the sample **Corrected claim form**, **Accept all clean suggested matches**, then **Mark intake checks complete**. | Mismatch auto-resolves ("evidence changed"); status *Intake checks complete*; panel says this is not a coverage decision. |
| 19 | Click **Download intake report (Markdown)**; open **Dashboard**. | Report lists open/resolved findings, overrides, comparisons, submission proofs. Dashboard is badged **SYNTHETIC**. |

**Close (10 s):** "Deterministic rules own the checks, links and state changes; there is no model to hallucinate evidence. A live-model adapter could be added behind validators for classification and wording only."

## If something goes wrong

- Blank page or stale state → footer **Reset demo data**, or stop the server and run `npm run reset`.
- Port busy → `PORT=3100 npm start`.
- A refusal banner is not a crash: it is the proof/readiness/permission gate doing its job. Dismiss it and continue.

## Optional add-on: real OCR (60 seconds, needs Tesseract + Poppler)

1. Claimant view → *Add evidence* → upload `samples/poor_scan_unreadable.png`. The row shows **OCR rejected (NN%)**; open *Page 1*: the text was discarded and the page counts as unreadable. Nothing is guessed.
2. Upload `samples/lab_report_scan.pdf`. It is OCR-read, and the *Lab report* requirement stops being missing.
3. On `pharmacy_bill_scan.png` choose **Replace** and upload `samples/pharmacy_bill_scan_corrected.png`. The re-upload diff shows readable pages 0 → 1. Open *Page 1*: the banner says it was read by local OCR with a confidence, and that no AI model was used.
4. Say out loud: OCR can misread symbols (it read "₹" as "%" for us), so amounts from OCR pages are verified by a person.
