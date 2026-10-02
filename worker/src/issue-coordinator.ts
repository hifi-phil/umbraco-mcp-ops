// The Durable Object: one instance per issue/PR (addressed by
// `${owner}/${repo}#${number}` — see index.ts), serializing every webhook
// for that entity and owning its watchdog alarm. Thin on purpose — all the
// actual decision logic lives in coordinate.ts (dependency-injected, unit
// tested); this class only wires that logic to real ctx.storage, D1, and
// the GitHub/routines API clients. Two request shapes reach fetch(): the
// default path is a GitHub webhook (coordinateWebhook, authoritative);
// POST .../routine-signal is the direct routine-to-DO heartbeat channel
// (coordinateRoutineSignal, never authoritative — see
// graph/routines/from-routine.ts and coordinate.ts's doc comment on it).
//
// This class's own wiring is covered by test/issue-coordinator.test.ts —
// a fake ctx.storage/D1 plus a stubbed global fetch, same fake-deps shape
// as coordinate.test.ts, deliberately not @cloudflare/vitest-pool-workers
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
  type CiFix,
  type CoordinateInput,
  type Deps,
  type PendingFire,
  type RoutineSignalInput,
  type TransitionRow,
  watchdogMinutesFor,
} from "./coordinate";
import * as githubClient from "./github-client";
import { appBotLogin, appConfigured } from "./github-app";
import { fireRoutine } from "./routines-client";
import type { GitHubEnv } from "./github-client";
import type { RoutinesEnv } from "./routines-client";
import type { MergeGateFacts } from "../../graph/github/merge-gate";

export type IssueCoordinatorEnv = GitHubEnv &
  RoutinesEnv & {
    DB: D1Database;
    // "enforce" to write labels / fire routines for real; anything else
    // (including unset) is shadow — see coordinate.ts's resolveEnforced.
    MODE?: string;
    // The watchdog's own switch, only honoured under MODE=enforce: "enforce"
    // makes expiries move issues to ai-stuck and comment; else they only log.
    WATCHDOG?: string;
    // {"owner/repo": {"mode"?, "minutes"?}}: a repo's own watchdog switch and
    // timeout, over WATCHDOG and watchdogMinutesFor. See coordinate.ts.
    WATCHDOG_OVERRIDES_JSON?: string;
  };

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
const RECONCILE_REPORTED_KEY = "reconcileReported";
const COMPLETED_KEY = "completed";
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
   * auto-merge label and its CI finishing red) used to interleave mid-run:
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
   * reducer — see coordinate.ts's coordinateWatchdogExpired, which also
   * owns the retry-safe ordering (no pendingFire -> a harmless race). */
  async alarm(): Promise<void> {
    // The repo comes from the pending fire; no pending fire, nothing to do
    // (coordinateWatchdogExpired no-ops on that too).
    await this.serial(async () => {
      const pending = await this.ctx.storage.get<PendingFire>(PENDING_FIRE_KEY);
      await coordinateWatchdogExpired(this.deps(pending ?? undefined));
    });
  }

  /** Real I/O; coordinate.ts switches each event to shadow writes unless
   * `enforced` says otherwise. `ref` is the issue's repo, for its watchdog
   * override (a DO is one issue, so every call for it names the same repo). */
  private deps(ref?: { owner: string; repo: string; issueNumber?: number }): Deps {
    const override = ref ? watchdogOverrideFor(this.env.WATCHDOG_OVERRIDES_JSON, ref.owner, ref.repo) : undefined;
    const watchdogMinutes = (routine: string) => override?.minutes ?? watchdogMinutesFor(routine);
    return {
      enforced: resolveEnforced(this.env.MODE, override?.mode ?? this.env.WATCHDOG),
      watchdogMinutes,
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
      lastActivityAt: async () => {
        if (!ref) return null;
        const row = await this.env.DB.prepare(
          // A shadow reconcile row only records what a sweep saw; it isn't
          // activity on the issue, so it mustn't reset its idle clock.
          `SELECT MAX(created_at) AS at FROM transitions
            WHERE LOWER(owner) = LOWER(?) AND LOWER(repo) = LOWER(?) AND issue_number = ?
              AND NOT (event = 'reconcile_refire' AND mode = 'shadow')`,
        )
          .bind(ref.owner, ref.repo, ref.issueNumber ?? -1)
          .first<{ at: string | null }>();
        return row?.at ?? null;
      },
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
      fireRoutine: (owner: string, repo: string, issueNumber: number, routine: string) =>
        fireRoutine(this.env, owner, repo, issueNumber, routine),
      logTransition: async (row: TransitionRow) => {
        await this.insertTransition(row);
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
        await this.ctx.storage.put(PENDING_FIRE_KEY, info);
        await this.ctx.storage.setAlarm(Date.now() + watchdogMinutes(info.run) * 60_000);
      },
      clearPendingFire: async () => {
        await this.ctx.storage.delete(PENDING_FIRE_KEY);
        await this.ctx.storage.deleteAlarm();
      },
      watchdogArmed: async () => (await this.ctx.storage.getAlarm()) !== null,
      getPendingFire: async () => (await this.ctx.storage.get<PendingFire>(PENDING_FIRE_KEY)) ?? null,
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
          checkRuns: checkRuns as MergeGateFacts["checkRuns"],
          latestReviewState,
          mergeable: pull.mergeable,
        };
      },
    };
  }

  private async insertTransition(row: TransitionRow): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO transitions
         (delivery_id, owner, repo, issue_number, from_state, event, to_effect, run, dropped_reason, mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        row.deliveryId,
        row.owner,
        row.repo,
        row.issueNumber,
        row.fromState,
        row.event,
        row.toEffect,
        row.run,
        row.droppedReason,
        row.mode, // per event since Phase 4, not per Worker
      )
      .run();
  }
}
