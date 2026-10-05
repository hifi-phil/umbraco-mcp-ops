// The dashboard's model: the attached repos, the URL's filters, building
// and ordering the list from the repositories' rows, and formatting. Pure:
// no I/O, no markup (views/ renders it).

import type { StatusRow } from "../db/issue-status";
import type { GitHubEnv } from "../github-client";
import type { AuthEnv } from "../auth";
import { LABELS } from "@orchestrator/graph/constants/labels";

export type DashboardEnv = AuthEnv &
  Partial<GitHubEnv> & {
    DB: D1Database;
    STATUS_SECRET?: string;
    // Only its keys are read here: the attached repos.
    REPO_ROUTINES_JSON?: string;
    // The e2e sandbox repos, which the dashboard tags and lists last.
    LOG_READ_REPOS?: string;
    SWEEP_MODE?: string;
    SWEEP_ENFORCE_REPOS?: string;
  };

/** One row per issue or PR with a log: its latest row, and hints. */
export type ActivityRow = {
  owner: string;
  repo: string;
  issue_number: number;
  event: string;
  last_at: string;
  events: number;
  pr_hint: number; // 1 if any of its events only happens on a PR
};

export type ItemRow = { owner: string; repo: string; issue_number: number; kind: string | null; title: string | null; gh_state: string | null };

export type Item = {
  repo: string; // "owner/repo"
  n: number;
  kind: "issue" | "pr" | null; // null: not known yet
  title: string | null;
  closed: boolean;
  merged: boolean;
  ghOpen: boolean; // GitHub says it's open
  known: boolean; // the items table has it (else its title is to be looked up)
  status: StatusRow | null;
  lastEvent: string;
  lastAt: string;
  events: number;
};

export type Filters = {
  repo: string | null;
  type: "all" | "issue" | "pr";
  status: "all" | "open" | "running" | "attention" | "closed";
  n: number | null;
  open: { repo: string; n: number } | null;
  limit: number; // how many of the list to show
};

/** How often the list page reloads itself (a meta refresh: no script needed). */
export const REFRESH_SECONDS = 300;

export const PAGE = 100; // the list shows this many more per "Show more"
export const MAX_SHOWN = 1000;
export const MAX_ITEMS = 5000; // a safety cap on the grouped log; counts are exact below it

// A latest event that means it's closed, for the same older items.
const CLOSING_EVENTS = ["merged", "release_published", "issue_closed"];

/** The attached repos ("owner/repo", lowercased, sorted): REPO_ROUTINES_JSON's keys. */
export function attachedRepos(env: DashboardEnv): string[] {
  try {
    return Object.keys(JSON.parse(env.REPO_ROUTINES_JSON ?? "{}") as Record<string, unknown>)
      .map((r) => r.toLowerCase())
      .sort();
  } catch {
    return [];
  }
}

/** The e2e sandbox repos (LOG_READ_REPOS), lowercased. */
export function sandboxRepos(env: DashboardEnv): string[] {
  return (env.LOG_READ_REPOS ?? "")
    .split(",")
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
}

/** Real repos first, then the sandbox, each alphabetical. */
export const orderRepos = (repos: string[], sandbox: string[]) => [...repos.filter((r) => !sandbox.includes(r)), ...repos.filter((r) => sandbox.includes(r))];

export const pickRepo = (repos: string[], raw: string | null) => {
  const want = (raw ?? "").toLowerCase();
  return repos.includes(want) ? want : null;
};

/** The URL's filters, with anything unknown dropped to its default. */
export function readFilters(url: URL, repos: string[]): Filters {
  const p = url.searchParams;
  const type = p.get("type");
  const status = p.get("status");
  const n = Number(p.get("n"));
  const open = /^([^/]+\/[^/]+)\/(\d+)$/.exec(p.get("open") ?? "");
  const openRepo = open ? pickRepo(repos, open[1]!) : null;
  const limit = Number(p.get("limit"));
  return {
    repo: pickRepo(repos, p.get("repo")),
    type: type === "issue" || type === "pr" ? type : "all",
    status: status === "open" || status === "running" || status === "attention" || status === "closed" ? status : "all",
    n: Number.isInteger(n) && n > 0 ? n : null,
    open: open && openRepo ? { repo: openRepo, n: Number(open[2]) } : null,
    limit: Number.isInteger(limit) && limit > PAGE ? Math.min(limit, MAX_SHOWN) : PAGE,
  };
}

/** /status with these filters (defaults left out, so URLs stay short). */
export function listHref(f: Filters, change: Partial<Filters> = {}): string {
  const g = { ...f, ...change };
  const p = new URLSearchParams();
  if (g.repo) p.set("repo", g.repo);
  if (g.type !== "all") p.set("type", g.type);
  if (g.status !== "all") p.set("status", g.status);
  if (g.n) p.set("n", String(g.n));
  if (g.limit > PAGE) p.set("limit", String(g.limit));
  if (g.open) p.set("open", `${g.open.repo}/${g.open.n}`);
  const q = p.toString();
  return q ? `/status?${q}` : "/status";
}

/** The list's items: the log's issues and PRs, joined with what's live and known. */
export function buildItems(activity: ActivityRow[], status: StatusRow[], items: ItemRow[], repos: string[]): Item[] {
  const key = (o: string, r: string, n: number) => `${o}/${r}#${n}`.toLowerCase();
  const live = new Map(status.map((s) => [key(s.owner, s.repo, s.issue_number), s]));
  const known = new Map(items.map((i) => [key(i.owner, i.repo, i.issue_number), i]));
  return activity
    .filter((a) => repos.includes(`${a.owner}/${a.repo}`.toLowerCase()))
    .map((a) => {
      const k = key(a.owner, a.repo, a.issue_number);
      const meta = known.get(k);
      const s = live.get(k) ?? null;
      const merged = meta?.gh_state === "merged" || (!meta?.gh_state && a.event === "merged");
      const closed = meta?.gh_state ? meta.gh_state !== "open" : !s && CLOSING_EVENTS.includes(a.event);
      const ghOpen = meta?.gh_state === "open";
      return {
        repo: `${a.owner}/${a.repo}`.toLowerCase(),
        n: a.issue_number,
        // Not known yet: a PR-only event makes it a PR; otherwise it's almost
        // certainly an issue (the lookup corrects it if not).
        kind: meta?.kind === "pr" || meta?.kind === "issue" ? meta.kind : a.pr_hint ? "pr" : "issue",
        title: meta?.title ?? null,
        closed,
        merged,
        ghOpen,
        known: meta?.title != null,
        status: closed ? null : s,
        lastEvent: a.event,
        lastAt: a.last_at,
        events: a.events,
      };
    });
}

export const needsAttention = (i: Item) => !!i.status && (tone(i.status.state) === "danger" || tone(i.status.state) === "warning");
export const isOpen = (i: Item) => !i.closed && (!!i.status || i.ghOpen);

export function matches(i: Item, f: Filters, skip?: "type" | "status"): boolean {
  if (f.repo && i.repo !== f.repo) return false;
  if (f.n && i.n !== f.n) return false;
  if (skip !== "type" && f.type !== "all" && i.kind !== f.type) return false;
  if (skip !== "status") {
    if (f.status === "open" && !isOpen(i)) return false;
    if (f.status === "running" && !i.status?.running) return false;
    if (f.status === "attention" && !needsAttention(i)) return false;
    if (f.status === "closed" && !i.closed) return false;
  }
  return true;
}

/** Running first, then needing attention, then open, then by latest activity. */
function rank(i: Item): number {
  if (i.status?.running) return 0;
  if (needsAttention(i)) return 1;
  if (isOpen(i)) return 2;
  return 3;
}

/** D1's datetime('now') ("YYYY-MM-DD HH:MM:SS", UTC) or an ISO string, as epoch ms. */
export const toMs = (s: string) => Date.parse(s.includes("T") ? s : `${s.replace(" ", "T")}Z`);

export function ago(at: string | null, now: number): string {
  if (!at) return "";
  const ms = toMs(at);
  if (!Number.isFinite(ms)) return "";
  const m = Math.max(0, Math.round((now - ms) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/** HH:MM UTC, for "Updated". */
export const clock = (now: number) => `${new Date(now).toISOString().slice(11, 16)} UTC`;

/** DD-MM-YYYY HH:MM:SS UTC. */
export function when(at: string): string {
  const d = new Date(toMs(at));
  if (Number.isNaN(d.getTime())) return at;
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}

/** The portal's tag colour for a state: trouble, waiting on a person, or done. */
export function tone(state: string): string {
  if (state === LABELS.AI_STUCK || state === LABELS.MERGE_BLOCKED) return "danger";
  if (state === LABELS.AI_BLOCKED) return "warning";
  if (state === LABELS.PR_OPEN) return "positive";
  return "default";
}

/** A log row's effect, in words: its label move, a close, or nothing. */
export function effectText(toEffect: string | null): string {
  if (!toEffect) return "";
  try {
    const e = JSON.parse(toEffect) as { kind?: string; value?: string; change?: string; control?: string; enabled?: boolean; held?: string; by?: string };
    if (e.kind === "label" && e.value) return `→ ${e.value}`;
    if (e.kind === "unlabel") return "label removed";
    if (e.kind === "close") return "closed";
    if (e.kind === "manual" && e.change) return `by hand: ${e.change}`;
    if (e.kind === "noop") return e.held ? `nothing (held: ${e.held})` : "no change";
    if (e.control) return `${e.control} turned ${e.enabled ? "on" : "off"}${e.by ? ` by ${e.by}` : ""}`;
    return toEffect;
  } catch {
    return toEffect;
  }
}

/** Who caused a log row, for "· by …": the Worker's own (the watchdog, the
 * sweep), another app's bot, or a person (whom the view marks). */
export function actorLabel(actor: string | null | undefined): { text: string; person: boolean } | null {
  if (!actor) return null;
  if (actor === "watchdog" || actor === "sweep") return { text: `the ${actor}`, person: false };
  return { text: actor, person: !actor.endsWith("[bot]") };
}

export const githubHref = (repo: string, n: number) => `https://github.com/${repo.split("/").map(encodeURIComponent).join("/")}/issues/${n}`;

/** What the list shows, in its order, before paging. */
export function visible(items: Item[], f: Filters): Item[] {
  return items.filter((i) => matches(i, f)).sort((a, b) => rank(a) - rank(b) || toMs(b.lastAt) - toMs(a.lastAt));
}

/** A row's id, for the link that keeps it in view. */
export const rowId = (i: { repo: string; n: number }) => `i-${i.repo.replace(/[^a-z0-9]+/g, "-")}-${i.n}`;

