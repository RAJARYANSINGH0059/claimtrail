// Small DOM helpers. Everything is built with textContent/createTextNode, never innerHTML,
// so uploaded file names, notes and document text cannot inject markup.
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// label, tone, icon: status is always conveyed by text + icon, never colour alone
const META = {
  matched: ['Matched', 'ok', '✓'], missing: ['Missing', 'bad', '✕'], unreadable: ['Unreadable', 'warn', '▲'],
  ambiguous: ['Ambiguous', 'warn', '?'], needs_review: ['Needs review', 'warn', '◆'],
  match: ['Match', 'ok', '✓'], mismatch: ['Mismatch', 'bad', '✕'], not_found: ['Not found', 'info', '–'], not_comparable: ['Not comparable', 'info', '–'],
  blocker: ['Blocker', 'bad', '■'], review: ['Needs review', 'warn', '◆'], info: ['Info', 'info', 'i'],
  open: ['Open', 'warn', '○'], resolved: ['Resolved', 'ok', '●'],
  not_sent: ['Not sent', 'info', '–'], sent_claimed: ['Sent, no proof', 'warn', '▲'], acknowledged: ['Acknowledged, proof on file', 'ok', '✓'],
  duplicate: ['Possible duplicate', 'warn', '⧉'],
};
export function chip(key, label) {
  const [text, tone, icon] = META[key] || [key, 'info', ''];
  return h('span', { class: `chip chip-${tone}` }, h('span', { class: 'chip-icon', 'aria-hidden': 'true' }, icon), label || text);
}

export const fmtTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
export const short = (s, n = 12) => String(s || '').slice(0, n);
export const kb = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)} KB` : `${n} B`);
export const pct = (c) => `${Math.round((c || 0) * 100)}%`;

export function btn(label, onclick, opts = {}) {
  return h('button', {
    type: 'button', class: `btn ${opts.kind ? 'btn-' + opts.kind : ''} ${opts.small ? 'btn-sm' : ''}`.trim(), onclick,
    'data-fid': opts.fid, 'aria-disabled': opts.blocked ? 'true' : null, 'aria-label': opts.aria, disabled: opts.disabled,
  }, label);
}

export function field(label, control, hint) {
  const id = 'f' + Math.random().toString(36).slice(2, 8);
  control.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, label), control, hint ? h('p', { class: 'hint' }, hint) : null);
}

let dialogCount = 0;
export function modal({ title, body, actions = [], wide = false }) {
  const tid = `dlg-title-${++dialogCount}`;
  const dlg = h('dialog', { class: 'modal' + (wide ? ' wide' : ''), 'aria-labelledby': tid });
  const close = () => dlg.close();
  dlg.append(
    h('div', { class: 'modal-head' }, h('h2', { id: tid }, title), h('button', { type: 'button', class: 'btn btn-sm', onclick: close, 'aria-label': 'Close dialog' }, 'Close')),
    h('div', { class: 'modal-body' }, body),
    ...(actions.length ? [h('div', { class: 'modal-foot' }, actions)] : []),
  );
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return { dlg, close };
}

export const errorBox = () => h('p', { class: 'form-error', role: 'alert', hidden: true });
export function showFormError(box, e) {
  box.hidden = false;
  box.replaceChildren(e.message || 'Something went wrong.');
  const reasons = e.details && e.details.reasons;
  if (reasons && reasons.length) box.append(h('ul', {}, reasons.map((r) => h('li', {}, r))));
}

export function readFileB64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error('The file could not be read.'));
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.readAsDataURL(file);
  });
}
export const textB64 = (text) => btoa(unescape(encodeURIComponent(text)));

export function table(headers, rows, { caption, cls } = {}) {
  return h('div', { class: 'table-wrap' }, h('table', { class: cls || '' },
    caption ? h('caption', { class: 'sr-only' }, caption) : null,
    h('thead', {}, h('tr', {}, headers.map((x) => h('th', { scope: 'col' }, x)))),
    h('tbody', {}, rows)));
}
export function row(labels, cells, cls) {
  return h('tr', { class: cls }, cells.map((c, i) => h('td', { 'data-label': labels[i] }, c)));
}
