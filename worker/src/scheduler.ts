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
//   and no errors) slows the next one to SWEEP_IDLE_MINUTES (60), not a
//   stop: a lost webhook is exactly when no /ensure would come to restart
//   it, so a quiet repo is still checked hourly;
// - every webhook calls /ensure (index.ts), which arms a missing alarm and
//   brings a slow one back to the normal interval;
// - a sweep that checked something writes a `sweep` row to D1.
// /ensure never waits on a sweep (webhooks would queue behind it, past
// GitHub's 10 s timeout). Instead a sweep only slows the chain if no
// /ensure arrived while it ran.

import { TRIGGER_LABELS, type ReconcileResult } from "./coordinate";
import { openWithLabel, type GitHubEnv } from "./github-client";
import { reposWithControlOff } from "./controls";

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
  // Minutes to the next sweep after a quiet one (default 60).
  SWEEP_IDLE_MINUTES?: string;
  // At most this many re-fires per sweep (default 3). The rest are asked in
  // shadow and come round again next sweep, so a backlog (say when a repo
  // first goes to enforce) drains a few at a time, not all at once.
  SWEEP_MAX_REFIRES?: string;
};

// checked: every candidate asked. live: those that could still need the
// sweep soon (running, recently active, or acted on / newly reported now);
// a settled one (completed, not triggered, already reported) isn't.
// wouldRefire: only newly reported ones, not every sweep's repeat.
export type SweepSummary = {
  repos: string[];
  // Repos skipped because their sweep is switched off (controls.ts).
  paused: string[];
  checked: number;
  live: number;
  refired: string[];
  wouldRefire: string[];
  errors: string[];
};

export const DEFAULT_SWEEP_MINUTES = 15;
export const DEFAULT_SWEEP_IDLE_MINUTES = 60;
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

  private idleIntervalMs(): number {
    const m = Number(this.env.SWEEP_IDLE_MINUTES);
    return Math.max((Number.isFinite(m) && m > 0 ? m : DEFAULT_SWEEP_IDLE_MINUTES) * 60_000, this.intervalMs());
  }

  // When /ensure last ran (this instance is the only one, so in memory is
  // enough; an evicted instance has no sweep in flight).
  private lastEnsure = 0;

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/ensure") {
      this.lastEnsure = Date.now();
      // Missing, or slowed for a quiet spell: back to the normal interval.
      const next = Date.now() + this.intervalMs();
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm === null || alarm > next) await this.ctx.storage.setAlarm(next);
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
      // Nothing live to watch, and no webhook arrived meanwhile: slow down.
      if (summary.live === 0 && summary.errors.length === 0 && this.lastEnsure < started) {
        await this.ctx.storage.setAlarm(started + this.idleIntervalMs());
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
    const summary: SweepSummary = { repos, paused: [], checked: 0, live: 0, refired: [], wouldRefire: [], errors: [] };

    // A repo whose sweep someone switched off on the dashboard is skipped.
    // Can't read the switches: sweep nothing this time rather than one that
    // was turned off (the error keeps the normal pace, so it's retried soon).
    let off: Set<string>;
    try {
      off = await reposWithControlOff(this.env.DB, "sweep");
    } catch (e) {
      summary.errors.push(`controls: ${e instanceof Error ? e.message : e}`);
      off = new Set(repos.map((r) => r.toLowerCase()));
    }

    for (const full of repos) {
      if (off.has(full.toLowerCase())) {
        summary.paused.push(full);
        continue;
      }
      const [owner, repo] = full.split("/") as [string, string];
      let candidates: Map<number, string>;
      try {
        const found = (await Promise.all(TRIGGER_LABELS.map((l) => openWithLabel(this.env, owner, repo, l)))).flat();
        candidates = new Map(found.map((c) => [c.number, c.updatedAt]));
      } catch (e) {
        summary.errors.push(`${full}: ${e instanceof Error ? e.message : e}`);
        continue;
      }
      for (const [issueNumber, updatedAt] of candidates) {
        summary.checked++;
        // One failing issue is recorded and skipped, not the end of the sweep.
        try {
          const stub = this.env.ISSUE_COORDINATOR.get(this.env.ISSUE_COORDINATOR.idFromName(doKey(owner, repo, issueNumber)));
          const res = await stub.fetch("https://issue-coordinator/reconcile", {
            method: "POST",
            body: JSON.stringify({
              owner,
              repo,
              issueNumber,
              updatedAt,
              enforced: this.enforcedFor(full) && summary.refired.length < this.maxRefires(),
            }),
          });
          const result = (await res.json().catch(() => null)) as ReconcileResult | { outcome: "error"; error: string } | null;
          const acted = result?.outcome === "refired" || (result?.outcome === "gated" && result.result.outcome === "applied");
          const fresh = result?.outcome === "would_refire" && !result.alreadyLogged;
          if (acted) summary.refired.push(`${full}#${issueNumber}`);
          else if (fresh) summary.wouldRefire.push(`${full}#${issueNumber}`);
          else if (!res.ok) summary.errors.push(`${full}#${issueNumber}: ${(result as { error?: string } | null)?.error ?? res.status}`);
          if (acted || fresh || result?.outcome === "watched" || result?.outcome === "recent") summary.live++;
        } catch (e) {
          summary.errors.push(`${full}#${issueNumber}: ${e instanceof Error ? e.message : e}`);
        }
      }
    }

    // Log only a sweep with something new: a re-fire, a newly reported
    // would-re-fire, or an error. Repeats of a settled issue aren't news.
    if (summary.refired.length === 0 && summary.wouldRefire.length === 0 && summary.errors.length === 0) return summary;
    await this.env.DB.prepare(
      `INSERT INTO transitions (delivery_id, owner, repo, issue_number, from_state, event, to_effect, run, dropped_reason, mode, actor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sweep')`,
    )
      // enforce when anything was really re-fired (SWEEP_ENFORCE_REPOS too),
      // so real re-fires never count in the shadow numbers.
      .bind(null, "_scheduler", "_", 0, "-", "sweep", JSON.stringify(summary), null, null, summary.refired.length > 0 || this.env.SWEEP_MODE === "enforce" ? "enforce" : "shadow")
      .run();
    return summary;
  }
}
