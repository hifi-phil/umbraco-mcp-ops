// A GitHub webhook, one issue or PR: dedupe, translate, the CI-fix and
// merge-gate cases, then apply. Also a person's label edit the table ignores
// (manual_override), and check_suite.completed.

import { ALL_LABELS, LABELS } from "@orchestrator/graph/constants/labels";
import { translate } from "@orchestrator/graph/github/from-github";
import { deriveMergeGateOutcome, failedCheckNames, hardBlockReason } from "@orchestrator/graph/github/merge-gate";
import { EVENTS, type Event } from "@orchestrator/graph/constants/events";
import { ROUTINES } from "@orchestrator/graph/constants/routines";
import { depsFor, type CoordinateInput, type CoordinateResult, type Deps } from "./types";
import { applyEvent, deriveState } from "./apply";
import { blockMerge, handToRework, settledGateFacts } from "./merge-gate";
import { reviewFindings, reviewGate } from "./review-gate";
import { handOffMerged, handOffRelease, prMerged, released } from "./stages";
import { releaseApproved } from "./release";
import { parseOutcomeArtifact } from "@orchestrator/graph/github/from-github";

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
  // Merged (by anyone, labelled or not): the issues its description closes
  // move to their next stage. Failing here fails the delivery, so it can be
  // redelivered; each issue dedupes its hand-off.
  if (input.payload.action === "pull_request.closed") await handOffMerged(deps, input);
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

  // A push by a rework this Worker started: for failing CI, back to
  // LABELS.AUTO_MERGING (or LABELS.AI_REVIEWING, if CI failed before the review); for the
  // review's findings, back to LABELS.AI_REVIEWING. Instead of just clearing
  // LABELS.AUTO_REWORKING, as a person's review rework does.
  if (event === EVENTS.REWORK_PUSHED || event === EVENTS.UNLABELLED_AUTO_REWORKING) {
    const ciFix = await deps.getCiFix();
    const reviewLoop = ciFix?.pending ? null : await deps.getReviewLoop();
    if (ciFix?.pending) {
      // LABELS.AUTO_REWORKING removed without a push (nothing to fix) ends the CI-fix
      // too, so a later review rework isn't mistaken for one.
      if (event === EVENTS.REWORK_PUSHED) {
        event = ciFix.returnTo === LABELS.AI_REVIEWING ? EVENTS.REVIEW_FIX_PUSHED : EVENTS.CI_FIX_PUSHED;
      }
      await deps.setCiFix({ ...ciFix, pending: false });
    } else if (reviewLoop?.fixPending) {
      if (event === EVENTS.REWORK_PUSHED) event = EVENTS.REVIEW_FIX_PUSHED;
      await deps.setReviewLoop({ ...reviewLoop, fixPending: false });
    }
  }

  // A review rework round (LABELS.AUTO_REWORKING added by a reviewer: the Worker's own
  // label changes never arrive as events). Counted per PR; past
  // caps.reviewReworks it goes to a person instead of looping. A person
  // retrying from LABELS.AI_STUCK starts a fresh count.
  if (event === EVENTS.LABELLED_AUTO_REWORKING) {
    const before = deriveState(currentLabels.filter((l) => l !== LABELS.AUTO_REWORKING));
    if (before === "none" || before === LABELS.AI_STUCK) {
      const rounds = before === LABELS.AI_STUCK ? 1 : (await deps.getReviewReworks()) + 1;
      if (rounds > deps.caps.reviewReworks) return capReviewRework(deps, input, currentLabels, rounds - 1);
      await deps.setReviewReworks(rounds);
      // From LABELS.AI_STUCK, the review's own count starts fresh too.
      if (before === LABELS.AI_STUCK) await deps.setReviewLoop(null);
    }
  }

  // LABELS.AI_REVIEWING added (by the build or a person): the label, then the CI gate,
  // which fires review-loop now if CI is already green. From LABELS.AI_STUCK, both
  // the review's counts start fresh.
  if (event === EVENTS.LABELLED_AI_REVIEWING) {
    if (!currentLabels.includes(LABELS.AI_REVIEWING)) return { outcome: "stale_label", event };
    // The label's check suite can be handled first (CI finishing as it went
    // on) and have fired the review already. Applying the label's rule now
    // would clear that pending fire and fire a second review (e2e #729,
    // 05-10-2026), so the label is already handled.
    if ((await deps.getPendingFire())?.run === ROUTINES.REVIEW_LOOP) return { outcome: "stale_label", event };
    if (deriveState(currentLabels.filter((l) => l !== LABELS.AI_REVIEWING)) === LABELS.AI_STUCK) {
      await deps.setReviewLoop(null);
      await deps.setCiFix(null);
    }
    const labelled = await applyEvent(deps, input, event, currentLabels);
    if (labelled.outcome !== "applied") return labelled;
    // What's on the PR now: the rule took off LABELS.AI_STUCK or LABELS.AI_BLOCKED.
    const now = currentLabels.filter((l) => l !== LABELS.AI_STUCK && l !== LABELS.AI_BLOCKED);
    const gated = await reviewGate(deps, input, now);
    return gated.outcome === "no_event" ? labelled : gated;
  }

  // review-loop's verdict. Findings are a counted round; a pass starts the
  // PR's next stage (LABELS.AUTO_MERGING) with fresh counts.
  if (event === EVENTS.REVIEW_FINDINGS && deriveState(currentLabels) === LABELS.AI_REVIEWING) {
    return reviewFindings(deps, input, currentLabels);
  }
  // The issue's stages after its PR (coordinate/stages.ts).
  if (event === EVENTS.PR_MERGED) return prMerged(deps, input, currentLabels);
  if (event === EVENTS.RELEASED) return released(deps, input, currentLabels);
  // The release split: the review passed (the Worker merges, then fires
  // release-publish), and release_published (from release-publish, or from
  // an agent that still publishes itself) closes the issue and hands
  // released to the issues it ships, with the tag it reported.
  if (event === EVENTS.RELEASE_APPROVED) return releaseApproved(deps, input, currentLabels);
  if (event === EVENTS.RELEASE_PUBLISHED) {
    const published = await applyEvent(deps, input, event, currentLabels);
    const outcome = parseOutcomeArtifact(input.payload.comment?.body);
    if (published.outcome === "applied" && outcome?.outcome === "release_published") {
      await handOffRelease(deps, input, outcome.version, outcome.tag ?? `v${outcome.version}`);
    }
    return published;
  }

  if (event === EVENTS.REVIEW_PASSED) {
    const passed = await applyEvent(deps, input, event, currentLabels);
    if (passed.outcome === "applied") {
      await deps.setReviewLoop(null);
      await deps.setCiFix(null);
    }
    return passed;
  }

  // LABELS.AUTO_MERGING added: check the PR before firing merge-flow. Reviews aren't
  // expected once the label is on, so this is where requested changes are
  // caught; conflicts are caught here and again each time CI finishes
  // (handleCheckSuiteCompleted). CI that has already failed goes straight
  // to rework.
  if (event === EVENTS.LABELLED_AUTO_MERGING) {
    // Run after LABELS.AUTO_MERGING has already gone (swapped out by CI finishing red
    // a moment earlier, found by e2e on PR #246), there's no gate left to check.
    if (!currentLabels.includes(LABELS.AUTO_MERGING)) return { outcome: "stale_label", event };
    // A human re-adding LABELS.AUTO_MERGING after LABELS.MERGE_BLOCKED starts a fresh count.
    if (currentLabels.includes(LABELS.MERGE_BLOCKED)) await deps.setCiFix(null);
    const facts = await settledGateFacts(deps, input);
    const reason = hardBlockReason(facts);
    if (reason) return blockMerge(deps, input, currentLabels, reason);
    if (deriveMergeGateOutcome(facts) === "soft") return handToRework(deps, input, currentLabels, facts);
  }

  const result = await applyEvent(deps, input, event, currentLabels);
  // A contextual event the table ignores here (say LABELS.AUTO_MERGING removed from
  // a LABELS.MERGE_BLOCKED PR) is still a person's edit worth a row.
  return result.outcome === "ignored" && human ? logManualOverride(deps, input, human, currentLabels) : result;
}

/** Review rework asked for past the cap: say so, and move the PR to
 * {@link LABELS.AI_STUCK} (the table's REWORK_CAP_REACHED rule) without firing. */
async function capReviewRework(deps: Deps, input: CoordinateInput, currentLabels: string[], rounds: number): Promise<CoordinateResult> {
  const result = await applyEvent(deps, input, EVENTS.REWORK_CAP_REACHED, currentLabels);
  if (result.outcome === "applied") {
    await depsFor(deps, EVENTS.REWORK_CAP_REACHED).io.commentOnIssue(
      input.owner,
      input.repo,
      input.issueNumber,
      `🛑 This PR has had ${rounds} review rework rounds, the most rework-loop is given (${deps.caps.reviewReworks}), so it's moved to \`${LABELS.AI_STUCK}\` ` +
        `for a person to look at. Re-add \`${LABELS.AUTO_REWORKING}\` to try again; that starts a fresh count. ` +
        `(Automatic, from the orchestrator.)`,
    );
  }
  return result;
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
 * way the table doesn't act on (cleared {@link LABELS.AI_BLOCKED}, added {@link LABELS.MERGE_BLOCKED},
 * removed {@link LABELS.AI_STUCK}, …). Nothing is decided or written to GitHub; a
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
 * PR currently in {@link LABELS.AI_REVIEWING} (the review's CI gate) or {@link LABELS.AUTO_MERGING}
 * (mirrors merge-flow's own gate), and only once the suite has actually
 * finished (a mid-flight `status: "in_progress"` webhook has nothing to
 * decide yet).
 */
async function handleCheckSuiteCompleted(deps: Deps, input: CoordinateInput): Promise<CoordinateResult> {
  if (input.payload.check_suite?.status !== "completed") return { outcome: "no_event" };

  const currentLabels = await deps.getLabels(input.owner, input.repo, input.issueNumber);
  if (deriveState(currentLabels) === LABELS.AI_REVIEWING) return reviewGate(deps, input, currentLabels);
  if (!currentLabels.includes(LABELS.AUTO_MERGING)) return { outcome: "no_event" };

  // Same reading as when LABELS.AUTO_MERGING is added. CI often fails within seconds
  // of a push, before GitHub has computed `mergeable`; waiting on that here
  // dropped the red CI for good (nothing else re-checks it), so an unknown
  // `mergeable` counts as "no known conflict", as hardBlockReason reads it.
  const facts = await settledGateFacts(deps, input);
  if (facts.checkRuns.some((c) => c.status !== "completed")) return { outcome: "no_event" };

  const reason = hardBlockReason(facts);
  if (reason) return blockMerge(deps, input, currentLabels, reason);
  if (failedCheckNames(facts).length > 0) return handToRework(deps, input, currentLabels, facts);

  // Green: merge-flow again, once per head commit. merge-flow never signals
  // completion (its result is the merge itself), so a pending fire can't say
  // whether one is still running; a second alongside a slow first is
  // harmless, a merge being idempotent.
  if (facts.checkRuns.length > 0 && facts.headSha && (await deps.getMergeFiredFor()) !== facts.headSha) {
    const result = await applyEvent(deps, input, EVENTS.MERGE_GATE_PASSED, currentLabels);
    if (result.outcome === "applied") await deps.setMergeFiredFor(facts.headSha);
    return result;
  }
  return { outcome: "no_event" };
}
