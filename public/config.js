// Default (local / same-origin) frontend config. Contains NO secrets. The Vercel build (npm run build:dist) writes
// dist/config.js with the public Render API origin from CLAIMTRAIL_API_BASE_URL; this tracked file is never modified.
window.CLAIMTRAIL_CONFIG = { apiBaseUrl: '' };
