'use strict';
/**
 * Environment configuration. Pure: loadConfig(env) never reads the filesystem or the network and never
 * returns the Sarvam key to callers that build public output (use publicAiStatus for that).
 *
 *   AI_PROVIDER      rules (default) | sarvam. Anything else fails SAFE: rules mode + a visible warning.
 *   SARVAM_API_KEY   server-side secret. Never sent to the browser, logged or stored in the case.
 *   FRONTEND_ORIGINS comma-separated EXACT origins allowed by CORS (e.g. https://claimtrail.vercel.app). "*" is rejected.
 *   HOST / PORT      hosted production binds 0.0.0.0 and honours PORT; local default is 127.0.0.1:3000.
 *   CLAIMTRAIL_DATA  path of the JSON state file (a persistent-disk path on Render, else ephemeral).
 */
const path = require('node:path');

const KNOWN_PROVIDERS = ['rules', 'sarvam'];

function parseOrigins(raw, warnings) {
  const out = [];
  for (const part of String(raw || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (part.includes('*')) { warnings.push(`FRONTEND_ORIGINS entry ignored (wildcards are not supported; list exact origins): ${part.slice(0, 60)}`); continue; }
    let u;
    try { u = new URL(part); } catch { warnings.push(`FRONTEND_ORIGINS entry ignored (not a URL): ${part.slice(0, 60)}`); continue; }
    const exact = u.origin;
    if (!/^https?:$/.test(u.protocol) || part.replace(/\/$/, '') !== exact || part === '*') { warnings.push(`FRONTEND_ORIGINS entry ignored (must be an exact origin like https://app.example.com): ${part.slice(0, 60)}`); continue; }
    if (!out.includes(exact)) out.push(exact);
  }
  return out;
}

function loadConfig(env = process.env) {
  const warnings = [];
  const nodeEnv = env.NODE_ENV || 'development';
  const hosted = nodeEnv === 'production' || !!env.RENDER;
  const requested = String(env.AI_PROVIDER || 'rules').trim().toLowerCase() || 'rules';
  const hasKey = typeof env.SARVAM_API_KEY === 'string' && env.SARVAM_API_KEY.trim().length >= 8;
  let provider = 'rules', state = 'rules_only', message = 'Rules only: no document or text leaves this server.';
  if (!KNOWN_PROVIDERS.includes(requested)) {
    state = 'invalid_config'; message = `Unknown AI_PROVIDER "${requested.slice(0, 30)}". Running in rules-only mode.`;
    warnings.push(message);
  } else if (requested === 'sarvam') {
    if (hasKey) { provider = 'sarvam'; state = 'sarvam_available'; message = 'Sarvam is available. A file or text is sent to Sarvam AI only after you confirm each action.'; }
    else { state = 'sarvam_missing_key'; message = 'AI_PROVIDER=sarvam but SARVAM_API_KEY is not set. Running in rules-only mode.'; warnings.push(message); }
  }
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) { warnings.push('PORT is invalid; using 3000.'); }
  return {
    nodeEnv, hosted,
    host: env.HOST || (hosted ? '0.0.0.0' : '127.0.0.1'),
    port: Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 3000,
    dataFile: env.CLAIMTRAIL_DATA ? path.resolve(env.CLAIMTRAIL_DATA) : null,
    frontendOrigins: parseOrigins(env.FRONTEND_ORIGINS, warnings),
    ai: { requested, provider, state, message },
    sarvamApiKey: provider === 'sarvam' ? env.SARVAM_API_KEY.trim() : null, // internal use only
    warnings,
  };
}

/** Safe, public status for the UI and /api/ai/status. Contains no secret and no environment values. */
function publicAiStatus(config, { cloudDocuments = 0 } = {}) {
  const on = config.ai.provider === 'sarvam';
  const badge = cloudDocuments > 0 ? 'sarvam_used' : on ? 'sarvam_available' : 'rules_only';
  return {
    badge,
    badgeLabel: { rules_only: 'Rules only', sarvam_available: 'Sarvam available', sarvam_used: 'Sarvam analysis used' }[badge],
    provider: config.ai.provider, state: config.ai.state, message: config.ai.message,
    externalProcessing: on,
    features: { documentAnalysis: on, translation: on, localOcr: undefined },
    cloudDocuments,
    cloudNotice: 'Sarvam processing sends the selected file to an external AI service (api.sarvam.ai). Use synthetic or sample documents only; never real patient or insurance documents.',
  };
}

module.exports = { loadConfig, publicAiStatus, parseOrigins, KNOWN_PROVIDERS };
