// Central API base-URL resolution. EVERY network call in the browser code goes through apiUrl().
//   - Local / monolithic mode: window.CLAIMTRAIL_CONFIG.apiBaseUrl is "" -> same-origin relative paths.
//   - Split mode (Vercel static frontend + Render API): the build writes the PUBLIC Render origin into dist/config.js.
// The base must be an ORIGIN ONLY (https://api.example.com): no path, query, credentials or fragment. Paths passed in
// must be fixed application routes starting with /api/ (never user-controlled URLs), so a user can never redirect a
// request to another host through this function.

const SAFE_PATH = /^\/api\/[A-Za-z0-9._~\-/?=&%,:+]*$/;

export function normalizeApiBase(raw) {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') throw new Error('CLAIMTRAIL apiBaseUrl must be a string.');
  const s = raw.trim();
  if (s === '') return '';
  let u;
  try { u = new URL(s); } catch { throw new Error('CLAIMTRAIL apiBaseUrl is not a valid URL.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('CLAIMTRAIL apiBaseUrl must use http or https.');
  if (u.username || u.password) throw new Error('CLAIMTRAIL apiBaseUrl must not contain credentials.');
  if (u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) throw new Error('CLAIMTRAIL apiBaseUrl must be an origin only (no path, query or fragment).');
  return u.origin;
}

export function configuredBase(scope = globalThis) {
  const c = scope && scope.CLAIMTRAIL_CONFIG;
  return normalizeApiBase(c && c.apiBaseUrl);
}

export function apiUrl(path, base = configuredBase()) {
  if (typeof path !== 'string' || !SAFE_PATH.test(path) || path.includes('//') || path.includes('..')) throw new Error('Refusing to call a non-API path.');
  return base + path;
}
