# Deployment

Local checks only were run for this document; **no Vercel, Render or GitHub deployment was performed**.

## Option A: split (Vercel static frontend + Render Node API)
**Render (API)** — Blueprint `render.yaml`, or manually:
- Build: `npm ci --omit=dev` · Start: `npm start` · Health check path: `/api/health/ready`
- Env: `FRONTEND_ORIGINS=https://<your-app>.vercel.app` (exact origins, comma-separated; no wildcard, no trailing slash), `AI_PROVIDER=rules` (or `sarvam`), `SARVAM_API_KEY` (secret, only if `sarvam`), `CLAIMTRAIL_DATA=/var/data/state.json` (only with a paid persistent disk).
- Render supplies `PORT`; the server binds `0.0.0.0` when hosted. Free tier = ephemeral disk and cold starts: state resets on restart/redeploy (fine for a synthetic demo). Paid disk: run a single instance (JSON file store, no zero-downtime deploys).

**Vercel (frontend)** — `vercel.json` included.
- Install: `npm ci --omit=dev` · Build: `npm run build:dist` · Output: `dist`
- Env: `CLAIMTRAIL_API_BASE_URL=https://<api>.onrender.com` (public origin only; set separately for Preview and Production). Never put `SARVAM_API_KEY` here: the build fails if it appears in `dist/`.
- Invalid base (path, credentials, non-http) fails the build.

Order: deploy Render → copy its URL into Vercel → deploy Vercel → copy the Vercel URL into Render `FRONTEND_ORIGINS` → redeploy Render → `APP_URL=... API_BASE_URL=... npm run deploy:smoke` (non-mutating).

## Option B: Render only (monolith)
One Render web service, same build/start, leave `FRONTEND_ORIGINS` and `CLAIMTRAIL_API_BASE_URL` unset; the server serves UI and API from one origin.

## Rollback
Vercel: promote the previous deployment. Render: redeploy the previous commit. Config-only issue: fix the env var and redeploy.

## Troubleshooting
| Symptom | Cause |
|---|---|
| "blocking this site (CORS)" banner | Vercel origin missing/typo in `FRONTEND_ORIGINS` (scheme, port, trailing slash must match) |
| First load slow | Render free tier cold start |
| UI says frontend misconfigured | `CLAIMTRAIL_API_BASE_URL` not an origin |
| Sarvam badge says rules only | `AI_PROVIDER` unset/invalid (fails safe) or key missing |
| Data gone after redeploy | Free tier has no persistent disk |

## CI
`.github/workflows/ci.yml`: Node 20/22 matrix running check, test, smoke, ui-smoke, ui-smoke:split, build:dist. Never calls live Sarvam. **Not yet run on GitHub.**
