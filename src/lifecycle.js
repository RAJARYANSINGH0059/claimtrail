'use strict';
/**
 * Lifecycle + role/permission rules. Pure data and pure functions.
 * "Intake checks complete" means configured intake QA passed. It is NOT a coverage decision.
 * ClaimTrail never transmits a packet: "Submitted" means the claimant RECORDED a submission made
 * through the insurer's own channel, and it can only be recorded with proof.
 */
const ROLES = ['claimant', 'reviewer'];

const STATES = [
  ['draft', 'Draft'],
  ['preparing', 'Preparing'],
  ['ready_for_review', 'Ready for review'],
  ['submitted', 'Submitted (proof on file)'],
  ['intake_review', 'Intake review'],
  ['action_required', 'Action required'],
  ['resubmitted', 'Resubmitted (proof on file)'],
  ['intake_complete', 'Intake checks complete'],
];
const LABELS = Object.fromEntries(STATES);

const TRANSITIONS = [
  { from: 'draft', to: 'preparing', role: 'claimant', label: 'Start preparing', guards: [] },
  { from: 'preparing', to: 'ready_for_review', role: 'claimant', label: 'Mark packet ready for review', guards: ['readiness'] },
  { from: 'ready_for_review', to: 'preparing', role: 'claimant', label: 'Return to preparing', guards: [] },
  { from: 'ready_for_review', to: 'submitted', role: 'claimant', label: 'Record submission (proof required)', guards: ['readiness', 'proof'] },
  { from: 'submitted', to: 'intake_review', role: 'reviewer', label: 'Start intake review', guards: [] },
  { from: 'intake_review', to: 'action_required', role: 'reviewer', label: 'Request corrections (draft only, nothing is sent)', guards: ['openFindings'] },
  { from: 'intake_review', to: 'intake_complete', role: 'reviewer', label: 'Mark intake checks complete', guards: ['noBlockers', 'confirmed'] },
  { from: 'action_required', to: 'resubmitted', role: 'claimant', label: 'Record resubmission (proof required)', guards: ['proof', 'newEvidence'] },
  { from: 'resubmitted', to: 'action_required', role: 'reviewer', label: 'Request further corrections (draft only, nothing is sent)', guards: ['openFindings'] },
  { from: 'resubmitted', to: 'intake_complete', role: 'reviewer', label: 'Mark intake checks complete', guards: ['noBlockers', 'confirmed'] },
];

/** Phases in which each role may change evidence. After submission the claimant's packet is frozen. */
const CLAIMANT_EDIT = new Set(['draft', 'preparing', 'action_required']);
const REVIEWER_EDIT = new Set(['intake_review', 'action_required', 'resubmitted']);

/** states: Set | 'edit' (role-specific edit set) | null (any state) */
const ACTIONS = {
  'state.view': { roles: ROLES, states: null },
  'requirement.edit': { roles: ['claimant'], states: CLAIMANT_EDIT },
  'requirement.extract': { roles: ['claimant'], states: null },
  'document.add': { roles: ROLES, states: 'edit' },
  'document.withdraw': { roles: ['claimant'], states: CLAIMANT_EDIT },
  'document.delivery': { roles: ['claimant'], states: CLAIMANT_EDIT },
  'link.decide': { roles: ROLES, states: 'edit' },
  'link.manual': { roles: ROLES, states: 'edit' },
  'link.acceptAll': { roles: ['reviewer'], states: REVIEWER_EDIT },
  'finding.resolve': { roles: ['reviewer'], states: REVIEWER_EDIT },
  'finding.reopen': { roles: ['reviewer'], states: REVIEWER_EDIT },
  'checks.rerun': { roles: ['reviewer'], states: REVIEWER_EDIT },
  'draft.followup': { roles: ['claimant'], states: null },
  'draft.correction': { roles: ['reviewer'], states: REVIEWER_EDIT },
  'export': { roles: ROLES, states: null },
  'report.view': { roles: ['reviewer'], states: null },
  'dashboard.view': { roles: ['reviewer'], states: null },
  'queue.view': { roles: ['reviewer'], states: null },
  'demo.reset': { roles: ROLES, states: null },
};

function check(role, action, status) {
  const a = ACTIONS[action];
  if (!a) return { ok: false, code: 'UNKNOWN_ACTION', message: `Unknown action ${action}` };
  if (!ROLES.includes(role)) return { ok: false, code: 'FORBIDDEN_ROLE', message: 'Unknown role.' };
  if (!a.roles.includes(role)) return { ok: false, code: 'FORBIDDEN_ROLE', message: `The ${role} role cannot perform "${action}" in this MVP.` };
  const set = a.states === 'edit' ? (role === 'claimant' ? CLAIMANT_EDIT : REVIEWER_EDIT) : a.states;
  if (set && !set.has(status)) {
    return { ok: false, code: 'WRONG_STATE', message: `"${action}" is not available while the case is "${LABELS[status] || status}".` };
  }
  return { ok: true };
}

const capabilities = (role, status) => Object.fromEntries(Object.keys(ACTIONS).map((k) => [k, check(role, k, status).ok]));

module.exports = { ROLES, STATES, LABELS, TRANSITIONS, CLAIMANT_EDIT, REVIEWER_EDIT, ACTIONS, check, capabilities };
