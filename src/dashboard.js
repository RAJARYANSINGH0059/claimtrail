'use strict';
/**
 * Operations dashboard. The headline metrics are computed from SYNTHETIC fixture rows that were
 * invented for layout. They are not measurements, benchmarks or results of any real pilot.
 */
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

function build({ synthRows, live }) {
  const n = synthRows.length;
  const withBlockers = synthRows.filter((r) => r.openBlockers > 0);
  return {
    synthetic: true,
    banner: 'SYNTHETIC — these figures are computed from invented fixture rows to show the layout. They are not real performance.',
    tiles: [
      { id: 'first_pass', label: 'First-pass completeness', value: pct(synthRows.filter((r) => r.firstPassComplete).length, n), unit: '%', definition: 'Share of synthetic cases with no correction request on first review.' },
      { id: 'repeat', label: 'Repeat-request / reopen rate', value: pct(synthRows.filter((r) => r.requestCount > 1 || r.reopened).length, n), unit: '%', definition: 'Share of synthetic cases that needed more than one request or were reopened.' },
      { id: 'ageing', label: 'Blocker ageing (mean)', value: withBlockers.length ? Math.round(mean(withBlockers.map((r) => r.ageDays)) * 10) / 10 : 0, unit: 'days', definition: 'Mean age of synthetic cases that still have open blockers.' },
      { id: 'triage', label: 'Time-to-triage (median)', value: Math.round(median(synthRows.map((r) => r.triageHours)) * 10) / 10, unit: 'hours', definition: 'Median hours from submission to first review in the synthetic rows.' },
    ],
    rows: synthRows.map((r) => ({ id: r.id, status: r.status, openBlockers: r.openBlockers, ageDays: r.ageDays, requestCount: r.requestCount, reopened: r.reopened, firstPassComplete: r.firstPassComplete, triageHours: r.triageHours })),
    live: { note: 'Counted live from this demo case in the shared store (demo timestamps).', ...live },
  };
}

module.exports = { build };
