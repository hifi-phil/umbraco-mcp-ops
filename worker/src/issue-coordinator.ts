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
  coordinateRoutineSignal,
  coordinateWatchdogExpired,
  resolveEnforced,
  type CoordinateInput,
  type Deps,
  type PendingFire,
  type RoutineSignalInput,
  type TransitionRow,
  watchdogMinutesFor,
} from "./coordinate";
import * as githubClient from "./github-client";
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
  };

const PENDING_FIRE_KEY = "pendingFire";
const seenKeyFor = (deliveryId: string) => `seen:${deliveryId}`;

export class IssueCoordinator {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: IssueCoordinatorEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

    if (new URL(request.url).pathname === "/routine-signal") {
      let input: RoutineSignalInput;
      try {
        input = await request.json();
      } catch {
        return new Response("invalid JSON body", { status: 400 });
      }
      const result = await coordinateRoutineSignal(this.deps(), input);
      return Response.json(result);
    }

    let input: CoordinateInput;
    try {
      input = await request.json();
    } catch {
      return new Response("invalid JSON body", { status: 400 });
    }

    const result = await coordinateWebhook(this.deps(), input);
    return Response.json(result);
  }

  /** The watchdog: fires watchdogMinutesFor(run) after a watched routine was fired
   * (or after its last heartbeat), unless a later event for the same issue
   * cancelled it first. The expiry itself is a real event through the
   * reducer — see coordinate.ts's coordinateWatchdogExpired, which also
   * owns the retry-safe ordering (no pendingFire -> a harmless race). */
  async alarm(): Promise<void> {
    await coordinateWatchdogExpired(this.deps());
  }

  /** Real I/O; coordinate.ts switches each event to shadow writes unless
   * `enforced` says otherwise. */
  private deps(): Deps {
    return {
      enforced: resolveEnforced(this.env.MODE, this.env.WATCHDOG),
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
        await this.ctx.storage.put(PENDING_FIRE_KEY, info);
        await this.ctx.storage.setAlarm(Date.now() + watchdogMinutesFor(info.run) * 60_000);
      },
      clearPendingFire: async () => {
        await this.ctx.storage.delete(PENDING_FIRE_KEY);
        await this.ctx.storage.deleteAlarm();
      },
      getPendingFire: async () => (await this.ctx.storage.get<PendingFire>(PENDING_FIRE_KEY)) ?? null,
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
        null, // delivery_id isn't threaded through to the log row today — see README's known gaps
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
