// A GitHub webhook, one issue or PR: dedupe, translate, the CI-fix and
// merge-gate cases, then apply. Also a person's label edit the table ignores
// (manual_override), and check_suite.completed.

import { ALL_LABELS, LABELS } from "@orchestrator/graph/constants/labels";
import { translate } from "@orchestrator/graph/github/from-github";
import { deriveMergeGateOutcome, failedCheckNames, hardBlockReason } from "@orchestrator/graph/github/merge-gate";
import { EVENTS, type Event } from "@orchestrator/graph/constants/events";
import { depsFor, type CoordinateInput, type CoordinateResult, type Deps } from "./types";
import { applyEvent, deriveState } from "./apply";
import { blockMerge, handToRework, settledGateFacts } from "./merge-gate";

/**
 * The literal implementation of translate() -> reduce() -> labelOps() +
 * fire, given the labels actually present right now (re-read fresh every
 * time via deps.getLabels — see graph/github/to-github.ts's labelOps()
 * doc comment for why that matters). This function IS the reducer's real
 * decision path; everything graph/ built is exercised here for real.
 *
 * check_suite.completed is special-cased before translate() ever runs:
 * deciding MERGE_GATE_FAILED_SOFT/HARD needs facts translate() can't see
 * (the full check-run list, review state, mergeability — not just the one
 * check_suite payload) — that's I/O, so it can't live in the deliberately
 * pure translate(). See graph/github/merge-gate.ts.
 */
export async function coordinateWebhook(
  deps: Deps,
  input: CoordinateInput,
): Promise<CoordinateResult> {
  if (!input.deliveryId) return processWebhook(deps, input);

  // Claim the delivery before processing, so a duplicate arriving while
  // this one is mid-flight is dropped. But release the claim if processing
  // throws: GitHub redelivers with the SAME delivery id, and a claim left
  // behind by a failed attempt would dedupe that redelivery, losing the
  // event for good (found 30-09-2026: a redelivered 500 came back
  // "deduped").
  if (await deps.hasSeenDelivery(input.deliveryId)) return { outcome: "deduped" };
  await deps.markSeenDelivery(input.deliveryId);
  try {
    return await processWebhook(deps, input);
  } catch (e) {
    await deps.unmarkSeenDelivery(input.deliveryId);
    throw e;
  }
}

async function processWebhook(deps: Deps, input: CoordinateInput): Promise<CoordinateResult> {
  const result = await processEvent(deps, input);
  // Closed by anyone (a merge, a person, a release): off the dashboard,
  // which shows open issues. Last, so the close's own rule (issue_closed is
  // a noop that would otherwise re-write the row) can't put it back.
  // It stays gone: a late outcome or a watchdog expiry on the closed issue
  // doesn't put it back (the DO remembers the close until it's reopened).
  if (input.payload.action === "issues.closed" || input.payload.action === "pull_request.closed") {
    await deps.recordStatus(input, { kind: "gone", closed: true });
  }
  if (input.payload.action === "issues.reopened" || input.payload.action === "pull_request.reopened") {
    await deps.recordStatus(input, { kind: "reopened" });
  }
  return result;
}

async function processEvent(deps: Deps, input: CoordinateInput): Promise<CoordinateResult> {
  if (input.payload.action === "check_suite.completed") {
    return handleCheckSuiteCompleted(deps, input);
  }

  const botLogin = await deps.botLogin();
  let event = translate(input.payload, botLogin ? { botLogin } : {});
  const human = humanLabelChange(input.payload, botLogin);
  if (!event) return human ? logManualOverride(deps, input, human) : { outcome: "no_event" };

  // Fresh, per §3.4/to-github.ts's "never cache" principle -- and the one
  // set labelOps() below must see in full (including a label this event
  // itself just added), even though deriveState() below needs it filtered.
  const currentLabels = await deps.getLabels(input.owner, input.repo, input.issueNumber);

  // A push by a rework this Worker started for failing CI: hand it back to
  // auto-merge instead of just clearing auto-rework (a review rework).
  if (event === EVENTS.REWORK_PUSHED || event === EVENTS.UNLABELLED_AUTO_REWORKING) {
    const ciFix = await deps.getCiFix();
    if (ciFix?.pending) {
      // auto-rework removed without a push (nothing to fix) ends the CI-fix
      // too, so a later review rework isn't mistaken for one.
      if (event === EVENTS.REWORK_PUSHED) event = EVENTS.CI_FIX_PUSHED;
      await deps.setCiFix({ ...ciFix, pending: false });
    }
  }

  // auto-merge added: check the PR before firing merge-flow. Reviews aren't
  // expected once the label is on, so this is where requested changes are
  // caught; conflicts are caught here and again each time CI finishes
  // (handleCheckSuiteCompleted). CI that has already failed goes straight
  // to rework.
  if (event === EVENTS.LABELLED_AUTO_MERGING) {
    // Run after auto-merge has already gone (swapped out by CI finishing red
    // a moment earlier, found by e2e on PR #246), there's no gate left to check.
    if (!currentLabels.includes(LABELS.AUTO_MERGING)) return { outcome: "stale_label", event };
    // A human re-adding auto-merge after merge-blocked starts a fresh count.
    if (currentLabels.includes(LABELS.MERGE_BLOCKED)) await deps.setCiFix(null);
    const facts = await settledGateFacts(deps, input);
    const reason = hardBlockReason(facts);
    if (reason) return blockMerge(deps, input, currentLabels, reason);
    if (deriveMergeGateOutcome(facts) === "soft") return handToRework(deps, input, currentLabels, facts);
  }

  const result = await applyEvent(deps, input, event, currentLabels);
  // A contextual event the table ignores here (say auto-merge removed from
  // a merge-blocked PR) is still a person's edit worth a row.
  return result.outcome === "ignored" && human ? logManualOverride(deps, input, human, currentLabels) : result;
}

/** A person (anyone but the Worker's own App bot) adding or removing a label
 * the table tracks. */
type LabelChange = { sign: "+" | "-"; label: string };

function humanLabelChange(payload: CoordinateInput["payload"], botLogin: string | null): LabelChange | null {
  const m = payload.action.match(/^(issues|pull_request)\.(labeled|unlabeled)$/);
  const label = payload.label?.name;
  if (!m || !label || !(ALL_LABELS as readonly string[]).includes(label)) return null;
  if (botLogin && payload.sender?.login === botLogin) return null;
  return { sign: m[2] === "labeled" ? "+" : "-", label };
}

/**
 * 03-components.md's human escape hatch: a person moved a tracked label in a
 * way the table doesn't act on (cleared ai-blocked, added merge-blocked,
 * removed ai-stuck, …). Nothing is decided or written to GitHub; a
 * `manual_override` row records it, so the log stays the issue's whole
 * history. The App is what makes this possible: the Worker's own label
 * changes come from its bot, so any other one is a person's (or a loop
 * acting outside the table).
 */
async function logManualOverride(
  deps: Deps,
  input: CoordinateInput,
  change: LabelChange,
  labels?: string[],
): Promise<CoordinateResult> {
  const now = labels ?? (await deps.getLabels(input.owner, input.repo, input.issueNumber));
  const before = change.sign === "+" ? now.filter((l) => l !== change.label) : [...now, change.label];
  const by = input.payload.sender?.login ?? null;
  const summary = `${change.sign}${change.label}`;
  await deps.logTransition({
    deliveryId: input.deliveryId || null,
    owner: input.owner,
    repo: input.repo,
    issueNumber: input.issueNumber,
    fromState: deriveState(before),
    event: "manual_override",
    actor: by,
    toEffect: JSON.stringify({ kind: "manual", change: summary, by, now: deriveState(now) }),
    run: null,
    droppedReason: null,
    mode: depsFor(deps, "manual_override" as Event).mode,
  });
  return { outcome: "manual_override", change: summary, by };
}

/**
 * check_suite.completed's own real aggregation path: only matters for a
 * PR currently in `auto-merge` (mirrors merge-flow's own gate — nothing
 * else watches CI this way), and only once the suite has actually
 * finished (a mid-flight `status: "in_progress"` webhook has nothing to
 * decide yet).
 */
async function handleCheckSuiteCompleted(deps: Deps, input: CoordinateInput): Promise<CoordinateResult> {
  if (input.payload.check_suite?.status !== "completed") return { outcome: "no_event" };

  const currentLabels = await deps.getLabels(input.owner, input.repo, input.issueNumber);
  if (!currentLabels.includes(LABELS.AUTO_MERGING)) return { outcome: "no_event" };

  // Same reading as when auto-merge is added. CI often fails within seconds
  // of a push, before GitHub has computed `mergeable`; waiting on that here
  // dropped the red CI for good (nothing else re-checks it), so an unknown
  // `mergeable` counts as "no known conflict", as hardBlockReason reads it.
  const facts = await settledGateFacts(deps, input);
  if (facts.checkRuns.some((c) => c.status !== "completed")) return { outcome: "no_event" };

  const reason = hardBlockReason(facts);
  if (reason) return blockMerge(deps, input, currentLabels, reason);
  if (failedCheckNames(facts).length > 0) return handToRework(deps, input, currentLabels, facts);
  return { outcome: "no_event" };
}
