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
  type CoordinateInput,
  type PendingFire,
  type RoutineSignalInput,
} from "./coordinate";
import * as githubClient from "./github-client";
import { fireRoutine } from "./routines-client";
import type { GitHubEnv } from "./github-client";
import type { RoutinesEnv } from "./routines-client";
import type { MergeGateFacts } from "../../graph/github/merge-gate";

export type IssueCoordinatorEnv = GitHubEnv &
  RoutinesEnv & {
    DB: D1Database;
  };

const WATCHDOG_MINUTES = 30;
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

  /** The watchdog: fires WATCHDOG_MINUTES after a routine was fired, unless
   * a later event for the same issue cancelled it first (coordinate.ts's
   * clearPendingFire, called whenever a rule fires with no `run`). */
  async alarm(): Promise<void> {
    const pending = await this.ctx.storage.get<PendingFire>(PENDING_FIRE_KEY);
    if (!pending) return; // resolved already; the alarm firing anyway is a harmless race, not a bug
    await this.ctx.storage.delete(PENDING_FIRE_KEY);
    await githubClient.commentOnIssue(
      this.env,
      pending.owner,
      pending.repo,
      pending.issueNumber,
      `⚠️ The \`${pending.run}\` routine hasn't reported back within ${WATCHDOG_MINUTES} minutes — it may have died mid-run. This comment is automatic; see docs/agent-orchestration/03-components.md §3.4.`,
    );
  }

  private deps() {
    return {
      getLabels: (owner: string, repo: string, issueNumber: number) =>
        githubClient.getLabels(this.env, owner, repo, issueNumber),
      addLabel: (owner: string, repo: string, issueNumber: number, label: string) =>
        githubClient.addLabel(this.env, owner, repo, issueNumber, label),
      removeLabel: (owner: string, repo: string, issueNumber: number, label: string) =>
        githubClient.removeLabel(this.env, owner, repo, issueNumber, label),
      closeIssue: (owner: string, repo: string, issueNumber: number) =>
        githubClient.closeIssue(this.env, owner, repo, issueNumber),
      fireRoutine: (routine: string, context: string) => fireRoutine(this.env, routine, context),
      logTransition: async (row: Parameters<typeof this.insertTransition>[0]) => {
        await this.insertTransition(row);
      },
      hasSeenDelivery: async (deliveryId: string) => {
        const seen = await this.ctx.storage.get<boolean>(seenKeyFor(deliveryId));
        return seen === true;
      },
      markSeenDelivery: async (deliveryId: string) => {
        await this.ctx.storage.put(seenKeyFor(deliveryId), true);
      },
      setPendingFire: async (info: PendingFire) => {
        await this.ctx.storage.put(PENDING_FIRE_KEY, info);
        await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MINUTES * 60_000);
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

  private async insertTransition(row: {
    owner: string;
    repo: string;
    issueNumber: number;
    fromState: string;
    event: string;
    toEffect: string | null;
    run: string | null;
    droppedReason: string | null;
  }): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO transitions
         (delivery_id, owner, repo, issue_number, from_state, event, to_effect, run, dropped_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      )
      .run();
  }
}
