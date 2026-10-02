// The Scheduler: one Durable Object (the "scheduler" instance) whose alarm
// runs the reconciliation sweep (Phase 7), and later scheduled agents. A DO
// alarm rather than a Cron Trigger: alarms are guaranteed at-least-once and
// retried on failure, while Cron Triggers have no retries or alerts and have
// been seen to stop silently.
//
// It only runs while there's something to watch:
// - each alarm sets the next one before doing any work, so a sweep that
//   fails (or throws) keeps the chain going;
// - a sweep that finds no candidates (no open issue with a trigger label,
//   and no errors) cancels that next alarm: the chain stops;
// - every webhook calls /ensure (index.ts), which re-arms a missing alarm.
//   An issue can only be left behind after a trigger label was added, and
//   that label's own webhook arms the sweep first, so stopping is safe;
// - a sweep that checked something writes a `sweep` row to D1.
// /ensure never waits on a sweep (webhooks would queue behind it, past
// GitHub's 10 s timeout). Instead a sweep only stops the chain if no
// /ensure arrived while it ran, so a webhook landing then still re-arms.

import { TRIGGER_LABELS, type ReconcileResult } from "./coordinate";
import { openWithLabel, type GitHubEnv } from "./github-client";

export type SchedulerEnv = GitHubEnv & {
  ISSUE_COORDINATOR: DurableObjectNamespace;
  DB: D1Database;
  REPO_ROUTINES_JSON: string;
  // Minutes between sweeps (default 15).
  SWEEP_MINUTES?: string;
  // "enforce" re-fires for real; anything else only logs what would be
  // re-fired. SWEEP_ENFORCE_REPOS (comma-separated owner/repo) enforces for
  // just those, e.g. the e2e sandbox.
  SWEEP_MODE?: string;
  SWEEP_ENFORCE_REPOS?: string;
  // At most this many re-fires per sweep (default 3). The rest are asked in
  // shadow and come round again next sweep, so a backlog (say when a repo
  // first goes to enforce) drains a few at a time, not all at once.
  SWEEP_MAX_REFIRES?: string;
};

export type SweepSummary = { repos: string[]; checked: number; refired: string[]; wouldRefire: string[]; errors: string[] };

export const DEFAULT_SWEEP_MINUTES = 15;
export const DEFAULT_SWEEP_MAX_REFIRES = 3;

/** The issue DO's key, as index.ts builds it. */
const doKey = (owner: string, repo: string, n: number) => `${owner}/${repo}`.toLowerCase() + `#${n}`;

export class Scheduler {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: SchedulerEnv,
  ) {}

  private intervalMs(): number {
    const m = Number(this.env.SWEEP_MINUTES);
    return (Number.isFinite(m) && m > 0 ? m : DEFAULT_SWEEP_MINUTES) * 60_000;
  }

  // When /ensure last ran (this instance is the only one, so in memory is
  // enough; an evicted instance has no sweep in flight).
  private lastEnsure = 0;

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/ensure") {
      this.lastEnsure = Date.now();
      if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + this.intervalMs());
      return Response.json({ ok: true });
    }
    if (path === "/sweep" && request.method === "POST") {
      // An on-demand sweep (e2e), optionally just some repos.
      const { repos } = ((await request.json().catch(() => ({}))) ?? {}) as { repos?: string[] };
      return Response.json(await this.sweep(repos));
    }
    return new Response("not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const started = Date.now();
    // Next one first: a failure below keeps the chain going.
    await this.ctx.storage.setAlarm(started + this.intervalMs());
    try {
      const summary = await this.sweep();
      // Nothing to watch, and no webhook re-armed it meanwhile: stop.
      if (summary.checked === 0 && summary.errors.length === 0 && this.lastEnsure < started) {
        await this.ctx.storage.deleteAlarm();
      }
    } catch (e) {
      console.error("sweep failed:", e instanceof Error ? e.message : e);
    }
  }

  private maxRefires(): number {
    const n = Number(this.env.SWEEP_MAX_REFIRES);
    return Number.isInteger(n) && n >= 0 ? n : DEFAULT_SWEEP_MAX_REFIRES;
  }

  private enforcedFor(repo: string): boolean {
    if (this.env.SWEEP_MODE === "enforce") return true;
    return (this.env.SWEEP_ENFORCE_REPOS ?? "")
      .split(",")
      .map((r) => r.trim().toLowerCase())
      .includes(repo.toLowerCase());
  }

  async sweep(only?: string[]): Promise<SweepSummary> {
    const all = Object.keys(JSON.parse(this.env.REPO_ROUTINES_JSON) as Record<string, unknown>);
    const repos = only ? all.filter((r) => only.some((o) => o.toLowerCase() === r.toLowerCase())) : all;
    const summary: SweepSummary = { repos, checked: 0, refired: [], wouldRefire: [], errors: [] };

    for (const full of repos) {
      const [owner, repo] = full.split("/") as [string, string];
      let numbers: number[];
      try {
        numbers = [...new Set((await Promise.all(TRIGGER_LABELS.map((l) => openWithLabel(this.env, owner, repo, l)))).flat())];
      } catch (e) {
        summary.errors.push(`${full}: ${e instanceof Error ? e.message : e}`);
        continue;
      }
      for (const issueNumber of numbers) {
        summary.checked++;
        const stub = this.env.ISSUE_COORDINATOR.get(this.env.ISSUE_COORDINATOR.idFromName(doKey(owner, repo, issueNumber)));
        const res = await stub.fetch("https://issue-coordinator/reconcile", {
          method: "POST",
          body: JSON.stringify({
            owner,
            repo,
            issueNumber,
            enforced: this.enforcedFor(full) && summary.refired.length < this.maxRefires(),
          }),
        });
        const result = (await res.json().catch(() => null)) as ReconcileResult | { outcome: "error"; error: string } | null;
        if (result?.outcome === "refired") summary.refired.push(`${full}#${issueNumber}`);
        else if (result?.outcome === "would_refire") summary.wouldRefire.push(`${full}#${issueNumber}`);
        else if (!res.ok) summary.errors.push(`${full}#${issueNumber}: ${(result as { error?: string } | null)?.error ?? res.status}`);
      }
    }

    // A quiet sweep isn't worth a row: log only one that checked something.
    if (summary.checked === 0 && summary.errors.length === 0) return summary;
    await this.env.DB.prepare(
      `INSERT INTO transitions (delivery_id, owner, repo, issue_number, from_state, event, to_effect, run, dropped_reason, mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(null, "_scheduler", "_", 0, "-", "sweep", JSON.stringify(summary), null, null, this.env.SWEEP_MODE === "enforce" ? "enforce" : "shadow")
      .run();
    return summary;
  }
}
