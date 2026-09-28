// Routing policy: turns Jev's raw answers into follow-ups, findings and escalations.
// All thresholds live here so they can be tuned against real PRs without touching
// question wording. Values are starting guesses, NOT calibrated.

export const T = {
  noulYes: 0.65, // at or above: treat as yes
  noulNo: 0.35, // at or below: treat as no; between the two = uncertain → fetch evidence
  choiceConfident: 0.6, // Choice/Score confidence below this = uncertain
  riskMedium: 1.5, // Score is 0..3; ≥ this counts as medium-or-worse
  riskHigh: 2.4,
};

const band = (p) => (p >= T.noulYes ? 'yes' : p <= T.noulNo ? 'no' : 'uncertain');

// After Tier 0: which Tier 1 requests to make for this hunk.
export function planFollowups(a, ctx) {
  const plan = [];
  const kind = a.change_kind.choice;
  const contract = kind === 'contract' || band(a.touches_contract.noul) === 'yes';

  if (contract && ctx.testHunks.length > 0) plan.push({ kind: 'tests_cover' });

  const uncertain = [];
  if (band(a.touches_contract.noul) === 'uncertain') uncertain.push('touches_contract');
  if (band(a.matches_description.noul) === 'uncertain') uncertain.push('matches_description');
  if (a.change_kind.confidence < T.choiceConfident) uncertain.push('change_kind');
  if (uncertain.length && ctx.canFetchFile) plan.push({ kind: 'reask_with_file', ids: uncertain });

  if (band(a.matches_description.noul) === 'no' && ctx.bullets.length >= 2) plan.push({ kind: 'which_goal' });

  return plan;
}

// After all rounds: findings for the report, and whether Tier 2 (Claude) should look.
// `a` has Tier 0 + speculative answers, with any re-asked answers already merged over them.
export function judge(a, followups, ctx) {
  const findings = [];
  const kind = a.change_kind.choice;
  const contract = kind === 'contract' || band(a.touches_contract.noul) === 'yes';
  const risk = a.risk.score;

  if (contract) {
    if (band(a.backcompat_if_contract.noul) === 'no') findings.push('contract change looks backwards-incompatible');
    const tc = followups.tests_cover_change;
    if (ctx.testHunks.length === 0) findings.push('contract change and the PR has no test changes');
    else if (tc && band(tc.noul) === 'no') findings.push('contract change not exercised by the PR’s test changes');
  }
  if (kind === 'refactor' && band(a.behaviour_shift_if_refactor.noul) === 'yes')
    findings.push('labelled a refactor but looks like it changes behaviour');
  if (kind === 'agent_instructions') {
    if (band(a.instruction_new_action_if_agent.noul) === 'yes') findings.push('changes what an agent will do');
    if (band(a.instruction_ambiguous_if_agent.noul) === 'yes') findings.push('new instruction reads two ways');
  }
  if (band(a.matches_description.noul) === 'no') {
    const g = followups.serves_goal;
    if (!g || g.choice === 'none') findings.push('not explained by the PR description');
  }

  const stillUncertain = ['touches_contract', 'matches_description'].filter((id) => band(a[id].noul) === 'uncertain');
  if (a.change_kind.confidence < T.choiceConfident) stillUncertain.push('change_kind');

  // Escalate on confident risk plus a concrete concern, or on high risk alone. Uncertainty by
  // itself is reported, not escalated: it means we lacked evidence, not that the code is bad.
  const escalate = risk >= T.riskHigh || (risk >= T.riskMedium && findings.length > 0);

  return { findings, stillUncertain, escalate };
}
