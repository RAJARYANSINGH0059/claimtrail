# Sarvam integration

Optional, off by default. `AI_PROVIDER=rules` (default) makes **zero** outbound calls. `AI_PROVIDER=sarvam` only *enables* the feature; nothing is sent until a user ticks the consent box for that one operation.

## Data flow
1. Operator sets `AI_PROVIDER=sarvam` and `SARVAM_API_KEY` as server environment variables (Render secret; never Vercel, never the browser, never git).
2. User opens **Read a scan with Sarvam**, picks a file (or a bundled synthetic sample), ticks "I consent to sending this file to Sarvam for this analysis".
3. `POST /api/ai/analyze` requires `externalProcessingConsent === true` (exact boolean). Missing/false → `422 CONSENT_REQUIRED`, no network call.
4. Server → `https://api.sarvam.ai` (fixed host, redirects refused): create job, upload, start, bounded polling, download markdown result. The paid create call is **never auto-retried**.
5. Result is held in server memory (TTL) as a *preview*. The user inspects per-page text and fields, then **Add to packet** or **Discard**. Cancel is available while running.
6. Added pages carry `ocr: {method:'sarvam-document-ai', status:'verify', confidence:null}`. Confidence is never invented. Machine-read values degrade a mismatch to *needs review*; they never auto-accept a link, clear a blocker, or mark anything ready/complete.

## Verified vs unverified
| Item | Status |
|---|---|
| Host, header name, job create → upload → start → status → result envelope | From Sarvam's public docs when this was built |
| Per-page shape inside the downloaded result | **Not documented; unverified.** Parser accepts only `page_number\|page_num` + `content\|markdown\|text`; anything else → `SARVAM_INVALID_RESPONSE` (no guessing) |
| Live call from this build | **NOT RUN** (no key used here) |

Confirm the real shape once, with your own key: `SARVAM_API_KEY=... AI_PROVIDER=sarvam npm run sarvam:smoke -- --i-consent-to-send-synthetic-sample` (sends one synthetic sample; prints only types/lengths, never content). Without the flag it exits 2 = NOT RUN.

## Failure matrix (all fall back to the deterministic path; the packet is never blocked)
| Condition | API result |
|---|---|
| Provider disabled / no key | `503 AI_PROVIDER_DISABLED`, UI hides nothing else |
| No consent | `422 CONSENT_REQUIRED` |
| Unsupported type / too large / too many pages | `4xx`, before any network call |
| Vendor 401/403/429/5xx, timeout, bad JSON, bad shape | Safe fixed message; no vendor body, URL or key in the error |
| Budget or concurrency exceeded | `429 CLOUD_BUDGET_EXCEEDED` / `ANALYSIS_BUSY` |

## Limits (config in `src/providers/sarvam.js` `DEFAULT_LIMITS`)
Bounded file size, page count, poll count/interval, per-request timeout, concurrent jobs, hourly call budget. Document text, file names, IDs, signed URLs and payloads are never logged.

## Translation
Hindi guidance (`/api/guidance`) is a deterministic phrase map and always works offline. Optional Sarvam Translate (`/api/ai/translate`) applies only to the case request letter, `hi-IN` only, with separate consent, and the result is rejected unless every ID, amount and date survives verbatim (no Devanagari numerals). The original is always shown beside the translation.

## Untrusted output
Model output is schema-checked and rendered via `textContent`. It cannot set claim state; only the deterministic lifecycle and a human reviewer can.
