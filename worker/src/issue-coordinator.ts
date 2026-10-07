// The Durable Object: one instance per issue/PR (addressed by
// `${owner}/${repo}#${number}` — see index.ts), serializing every webhook
// for that entity and owning its watchdog alarm. Thin on purpose — all the
// actual decision logic lives in coordinate/ (dependency-injected, unit
// tested); this class only wires that logic to real ctx.storage, D1, and
// the GitHub/routines API clients. Two request shapes reach fetch(): the
// default path is a GitHub webhook (coordinateWebhook, authoritative);
// POST .../routine-signal is the direct routine-to-DO heartbeat channel
// (coordinateRoutineSignal, never authoritative — see
// graph/routines/from-routine.ts and coordinate/routine-signal.ts's doc comment on it).
//
// This class's own wiring is covered by test/issue-coordinator.test.ts —
// a fake ctx.storage/D1 plus a stubbed global fetch, same fake-deps shape
// as coordinate/*.test.ts, deliberately not @cloudflare/vitest-pool-workers
// (see README.md for why). Covers: dedup, a real rule applying + logging
// to D1 + scheduling the alarm, the alarm actually *firing* (not just
// being set), and that two instances (standing in for two issues' real
// DOs) never share state. NOT covered: `wrangler dev --local`'s real
// Miniflare storage/D1 behaving exactly like these fakes assume, and a
// real elapsed-time alarm fire (vs. calling alarm() directly) — see
// README.md.

import {
  coordinateWebhook,
  coordinateReconcile,
  coordinateRoutineSignal,
  coordinateWatchdogExpired,
  resolveEnforced,
  watchdogOverrideFor,
  capsFor,
  DEFAULT_CAPS,
  type CiFix,
  type CoordinateInput,
  type Deps,
  type IssueRef,
  type PendingFire,
  type ReviewLoop,
  type Shipped,
  type StatusUpdate,
  type RoutineSignalInput,
  type TransitionRow,
  watchdogMinutesFor,
} from "./coordinate";
import * as githubClient from "./github-client";
import { recordLogged } from "./db/items";
import * as issueStatus from "./db/issue-status";
import * as transitions from "./db/transitions";
import { appBotLogin, appConfigured } from "./github-app";
import { fireRoutine } from "./routines-client";
import type { GitHubEnv } from "./github-client";
import type { RoutinesEnv } from "./routines-client";
import { mintLogToken } from "./work-log";
import * as logEntries from "./db/log-entries";
import type { MergeGateFacts } from "@orchestrator/graph/github/merge-gate";
import type { LABELS } from "@orchestrator/graph/constants/labels"; // for the {@link LABELS.…} references in its doc comments

export type IssueCoordinatorEnv = GitHubEnv &
  RoutinesEnv & {
    DB: D1Database;
    // "enforce" to write labels / fire routines for real; anything else
    // (including unset) is shadow — see coordinate/types.ts's resolveEnforced.
    MODE?: string;
    // The watchdog's own switch, only honoured under MODE=enforce: "enforce"
    // makes expiries move issues to LABELS.AI_STUCK and comment; else they only log.
    WATCHDOG?: string;
    // {"owner/repo": {"mode"?, "minutes"?}}: a repo's own watchdog switch and
    // timeout, over WATCHDOG and watchdogMinutesFor. See coordinate/.
    WATCHDOG_OVERRIDES_JSON?: string;
    // Per-repo loop caps (coordinate/types.ts's capsFor); the e2e sandbox's.
    CAP_OVERRIDES_JSON?: string;
    // Its own namespace, for handing an event to another item (Deps.forward).
    ISSUE_COORDINATOR?: DurableObjectNamespace;
    // Signs each fire's log_token (work-log.ts); unset, fires carry none.
    ROUTINE_SIGNAL_SECRET?: string;
  };

/** One DO per issue/PR, as index.ts routes them (lowercased owner/repo). */
const itemKey = (owner: string, repo: string, issueNumber: number) => `${owner}/${repo}`.toLowerCase() + `#${issueNumber}`;

/**
 * A thrown error becomes a 500 carrying its message, instead of escaping to
 * Cloudflare, which replaces it with a bare "error code: 1101". The message
 * (e.g. "GitHub API PATCH …/issues/152 failed: 403 …") then shows in the
 * webhook's Recent Deliveries. Only signed senders get this far (index.ts
 * checks the signature first), and the messages carry API statuses and
 * bodies, never tokens. Still a 500, so GitHub marks the delivery failed and
 * it can be redelivered (coordinateWebhook releases its dedupe claim first).
 */
async function respond(run: () => Promise<unknown>): Promise<Response> {
  try {
    return Response.json(await run());
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("coordinator failed:", error);
    return Response.json({ outcome: "error", error }, { status: 500 });
  }
}

const PENDING_FIRE_KEY = "pendingFire";
const CI_FIX_KEY = "ciFix";
const REVIEW_REWORKS_KEY = "reviewReworks"; // review rework rounds on this PR (MAX_REVIEW_REWORKS)
const SHIPPED_KEY = "shipped"; // the merged PR and commit that moved this issue to LABELS.READY_FOR_RELEASE
const RELEASE_MERGED_KEY = "releaseMerged"; // the release PR and commit the Worker merged (the release split)
const MERGE_FIRED_FOR_KEY = "mergeFiredFor"; // the head commit merge-flow was re-fired for on green CI
const REVIEW_LOOP_KEY = "reviewLoop"; // review-loop's own rounds on this PR (MAX_BOT_REVIEW_REWORKS)
const RECONCILE_REPORTED_KEY = "reconcileReported";
const COMPLETED_KEY = "completed";
const CLOSED_KEY = "closedOnGitHub"; // its status row stays gone until reopened
const seenKeyFor = (deliveryId: string) => `seen:${deliveryId}`;

export class IssueCoordinator {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: IssueCoordinatorEnv,
  ) {}

  /**
   * One request at a time for this issue, start to finish. Cloudflare only
   * holds back the next request while a DO awaits its own storage, not while
   * it awaits GitHub or a routine, so two webhooks for one PR (say its
   * {@link LABELS.AUTO_MERGING} label and its CI finishing red) used to interleave mid-run:
   * one read labels the other was halfway through swapping (found by e2e on
   * sandbox PR #168). In memory is enough: a DO instance is the only one for
   * its issue, and an evicted instance has nothing in flight.
   */
  private queue: Promise<unknown> = Promise.resolve();
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => {});
    return run;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

    // The sweep (scheduler.ts) asking whether this issue was left behind.
    if (new URL(request.url).pathname === "/reconcile") {
      let input: { owner: string; repo: string; issueNumber: number; enforced: boolean; updatedAt?: string };
      try {
        input = await request.json();
      } catch {
        return new Response("invalid JSON body", { status: 400 });
      }
      return this.serial(() =>
        respond(() => coordinateReconcile(this.deps(input), input, { enforced: input.enforced, updatedAt: input.updatedAt })),
      );
    }

    if (new URL(request.url).pathname === "/routine-signal") {
      let input: RoutineSignalInput;
      try {
        input = await request.json();
      } catch {
        return new Response("invalid JSON body", { status: 400 });
      }
      return this.serial(() => respond(() => coordinateRoutineSignal(this.deps(input), input)));
    }

    let input: CoordinateInput;
    try {
      input = await request.json();
    } catch {
      return new Response("invalid JSON body", { status: 400 });
    }

    return this.serial(() => respond(() => coordinateWebhook(this.deps(input), input)));
  }

  /** The watchdog: fires watchdogMinutesFor(run) after a watched routine was fired
   * (or after its last heartbeat), unless a later event for the same issue
   * cancelled it first. The expiry itself is a real event through the
   * reducer — see coordinate/watchdog.ts's coordinateWatchdogExpired, which also
   * owns the retry-safe ordering (no pendingFire -> a harmless race). */
  async alarm(): Promise<void> {
    // The repo comes from the pending fire; no pending fire, nothing to do
    // (coordinateWatchdogExpired no-ops on that too).
    await this.serial(async () => {
      const pending = await this.ctx.storage.get<PendingFire>(PENDING_FIRE_KEY);
      await coordinateWatchdogExpired(this.deps(pending ?? undefined));
    });
  }

  /** Real I/O; coordinate/ switches each event to shadow writes unless
   * `enforced` says otherwise. `ref` is the issue's repo, for its watchdog
   * override (a DO is one issue, so every call for it names the same repo). */
  private deps(ref?: { owner: string; repo: string; issueNumber?: number }): Deps {
    const override = ref ? watchdogOverrideFor(this.env.WATCHDOG_OVERRIDES_JSON, ref.owner, ref.repo) : undefined;
    const watchdogMinutes = (routine: string) => override?.minutes ?? watchdogMinutesFor(routine);
    return {
      enforced: resolveEnforced(this.env.MODE, override?.mode ?? this.env.WATCHDOG),
      watchdogMinutes,
      caps: ref ? capsFor(this.env.CAP_OVERRIDES_JSON, ref.owner, ref.repo) : DEFAULT_CAPS,
      botLogin: async () => (appConfigured(this.env) ? appBotLogin(this.env) : null),
      markCompleted: async (at: string) => {
        await this.ctx.storage.put(COMPLETED_KEY, at);
      },
      completedAt: async () => {
        const at = await this.ctx.storage.get<unknown>(COMPLETED_KEY);
        return typeof at === "string" ? at : null;
      },
      getReconcileReported: async () => (await this.ctx.storage.get<string>(RECONCILE_REPORTED_KEY)) ?? null,
      setReconcileReported: async (lastActivity: string) => {
        await this.ctx.storage.put(RECONCILE_REPORTED_KEY, lastActivity);
      },
      lastActivityAt: async () => (ref ? transitions.lastActivityAt(this.env.DB, ref.owner, ref.repo, ref.issueNumber ?? -1) : null),
      getLabels: (owner: string, repo: string, issueNumber: number) =>
        githubClient.getLabels(this.env, owner, repo, issueNumber),
      addLabel: (owner: string, repo: string, issueNumber: number, label: string) =>
        githubClient.addLabel(this.env, owner, repo, issueNumber, label),
      removeLabel: (owner: string, repo: string, issueNumber: number, label: string) =>
        githubClient.removeLabel(this.env, owner, repo, issueNumber, label),
      closeIssue: (owner: string, repo: string, issueNumber: number) =>
        githubClient.closeIssue(this.env, owner, repo, issueNumber),
      commentOnIssue: (owner: string, repo: string, issueNumber: number, body: string) =>
        githubClient.commentOnIssue(this.env, owner, repo, issueNumber, body),
      fireRoutine: async (owner: string, repo: string, issueNumber: number, routine: string) => {
        // The run's log_token (work-log.ts), good for twice its watchdog.
        const secret = this.env.ROUTINE_SIGNAL_SECRET;
        const token = secret
          ? await mintLogToken(secret, { owner, repo, item: issueNumber, routine }, 2 * watchdogMinutes(routine))
          : undefined;
        await fireRoutine(this.env, owner, repo, issueNumber, routine, token);
      },
      workLogFor: (owner: string, repo: string, items: number[]) => logEntries.forItems(this.env.DB, owner, repo, items),
      logTransition: async (row: TransitionRow) => {
        await this.insertTransition(row);
      },
      recordStatus: async (ref: IssueRef, update: StatusUpdate) => {
        // The dashboard's table is a side effect: never fail a transition on it.
        try {
          await this.writeStatus(ref, update);
        } catch (e) {
          console.error("status write failed:", e instanceof Error ? e.message : e);
        }
      },
      hasSeenDelivery: async (deliveryId: string) => {
        const seen = await this.ctx.storage.get<boolean>(seenKeyFor(deliveryId));
        return seen === true;
      },
      markSeenDelivery: async (deliveryId: string) => {
        await this.ctx.storage.put(seenKeyFor(deliveryId), true);
      },
      unmarkSeenDelivery: async (deliveryId: string) => {
        await this.ctx.storage.delete(seenKeyFor(deliveryId));
      },
      setPendingFire: async (info: PendingFire) => {
        await this.ctx.storage.delete(COMPLETED_KEY); // a new fire (or heartbeat): not finished
        const dueAt = Date.now() + watchdogMinutes(info.run) * 60_000;
        await this.ctx.storage.put(PENDING_FIRE_KEY, { ...info, dueAt });
        await this.ctx.storage.setAlarm(dueAt);
      },
      clearPendingFire: async () => {
        await this.ctx.storage.delete(PENDING_FIRE_KEY);
        await this.ctx.storage.deleteAlarm();
      },
      watchdogArmed: async () => (await this.ctx.storage.getAlarm()) !== null,
      getPendingFire: async () => (await this.ctx.storage.get<PendingFire>(PENDING_FIRE_KEY)) ?? null,
      getReviewReworks: async () => (await this.ctx.storage.get<number>(REVIEW_REWORKS_KEY)) ?? 0,
      setReviewReworks: async (rounds: number) => {
        await this.ctx.storage.put(REVIEW_REWORKS_KEY, rounds);
      },
      forward: async (to, payload, deliveryId) => {
        const ns = this.env.ISSUE_COORDINATOR;
        if (!ns) throw new Error("no ISSUE_COORDINATOR binding to hand an event to another item");
        const input: CoordinateInput = { deliveryId, owner: to.owner, repo: to.repo, issueNumber: to.issueNumber, payload };
        const res = await ns.get(ns.idFromName(itemKey(to.owner, to.repo, to.issueNumber))).fetch("https://issue-coordinator/", {
          method: "POST",
          body: JSON.stringify(input),
        });
        if (!res.ok) throw new Error(`hand-off to #${to.issueNumber} failed: ${res.status} ${await res.text()}`);
      },
      openWithLabel: async (owner, repo, label) =>
        (await githubClient.openWithLabel(this.env, owner, repo, label)).map((i) => i.number),
      commitInTag: (owner, repo, sha, tag) => githubClient.commitInTag(this.env, owner, repo, sha, tag),
      getPullDetails: (owner, repo, pr) => githubClient.getPullDetails(this.env, owner, repo, pr),
      mergePull: (owner, repo, pr, sha, method) => githubClient.mergePull(this.env, owner, repo, pr, sha, method),
      getShipped: async () => (await this.ctx.storage.get<Shipped>(SHIPPED_KEY)) ?? null,
      setShipped: async (shipped: Shipped) => {
        await this.ctx.storage.put(SHIPPED_KEY, shipped);
      },
      getReleaseMerged: async () => (await this.ctx.storage.get<Shipped>(RELEASE_MERGED_KEY)) ?? null,
      setReleaseMerged: async (merged: Shipped | null) => {
        if (merged) await this.ctx.storage.put(RELEASE_MERGED_KEY, merged);
        else await this.ctx.storage.delete(RELEASE_MERGED_KEY);
      },
      getMergeFiredFor: async () => (await this.ctx.storage.get<string>(MERGE_FIRED_FOR_KEY)) ?? null,
      setMergeFiredFor: async (sha: string) => {
        await this.ctx.storage.put(MERGE_FIRED_FOR_KEY, sha);
      },
      getReviewLoop: async () => (await this.ctx.storage.get<ReviewLoop>(REVIEW_LOOP_KEY)) ?? null,
      setReviewLoop: async (state: ReviewLoop | null) => {
        if (state) await this.ctx.storage.put(REVIEW_LOOP_KEY, state);
        else await this.ctx.storage.delete(REVIEW_LOOP_KEY);
      },
      getCiFix: async () => (await this.ctx.storage.get<CiFix>(CI_FIX_KEY)) ?? null,
      setCiFix: async (state: CiFix | null) => {
        if (state) await this.ctx.storage.put(CI_FIX_KEY, state);
        else await this.ctx.storage.delete(CI_FIX_KEY);
      },
      getMergeGateFacts: async (owner: string, repo: string, prNumber: number): Promise<MergeGateFacts> => {
        // checkRuns depends on the PR's head SHA, so getPull has to
        // resolve first; getLatestReviewState doesn't, so it runs alongside it.
        const [pull, latestReviewState] = await Promise.all([
          githubClient.getPull(this.env, owner, repo, prNumber),
          githubClient.getLatestReviewState(this.env, owner, repo, prNumber),
        ]);
        const checkRuns = await githubClient.getCheckRuns(this.env, owner, repo, pull.headSha);
        return {
          headSha: pull.headSha,
          checkRuns: checkRuns as MergeGateFacts["checkRuns"],
          latestReviewState,
          mergeable: pull.mergeable,
        };
      },
    };
  }

  /** The issue's live-status row (db/issue-status.ts). */
  private async writeStatus(ref: IssueRef, update: StatusUpdate): Promise<void> {
    const db = this.env.DB;
    switch (update.kind) {
      case "gone":
        if (update.closed) await this.ctx.storage.put(CLOSED_KEY, true);
        return issueStatus.remove(db, ref);
      case "reopened":
        await this.ctx.storage.delete(CLOSED_KEY);
        return;
      case "step":
        return issueStatus.setStep(db, ref, update.step, update.at);
      case "done":
        return issueStatus.setDone(db, ref);
      case "rework":
        return issueStatus.setRework(db, ref, update.count);
      case "transition": {
        if (await this.ctx.storage.get<boolean>(CLOSED_KEY)) return;
        const reworkCount = (await this.ctx.storage.get<CiFix>(CI_FIX_KEY))?.attempts ?? 0;
        return issueStatus.upsertTransition(db, ref, { state: update.state, run: update.run, running: update.running, reworkCount });
      }
    }
  }

  /** A log row, and its item's summary (what the dashboard reads instead of
   * the log). The summary is display only: never fails the transition. */
  private async insertTransition(row: TransitionRow): Promise<void> {
    await transitions.insert(this.env.DB, row);
    if (row.issueNumber > 0) {
      try {
        await recordLogged(this.env.DB, row.owner, row.repo, row.issueNumber, row.event);
      } catch (e) {
        console.error("item summary write failed:", e instanceof Error ? e.message : e);
      }
    }
  }
}
