// The dashboard (03-components.md §3.6), all under /status. Off unless
// STATUS_SECRET is set. People sign in with GitHub (auth.ts: a verified
// Umbraco email); scripts send `Authorization: Bearer <STATUS_SECRET>`.
//
// - GET /status: every issue and PR the Worker has a log for, in one list,
//   with the live status (issue_status, migrations/0004) where there is one,
//   kind and title from the items table (0006). Pills filter it (type,
//   status, repo; ?type= ?status= ?repo= ?n=), and ?open=owner/repo/N opens
//   that one's D1 transition log beside the list (under it on a narrow
//   screen). ?format=json gives the issue_status rows (scripts, e2e)
// - GET /status/repo?repo=o/r: a repo's controls (controls.ts) and its
//   repository-level activity
// - POST /status/controls: switches one (same origin only)
//
// Server-rendered, no script: every filter and selection is in the URL, so
// a view can be shared, and the list page reloads itself every
// REFRESH_SECONDS.

import { readSession, signInConfigured, type AuthEnv } from "./auth";
import { CONTROLS, controlsFor, isControl, setControl } from "./controls";
import { BACKFILL_MAX, backfillItems } from "./items";
import type { GitHubEnv } from "./github-client";

export type StatusEnv = AuthEnv &
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

/** Runs work after the response is sent (the Worker's ctx.waitUntil). */
export type Defer = (work: Promise<unknown>) => void;

export type StatusRow = {
  owner: string;
  repo: string;
  issue_number: number;
  state: string;
  routine: string | null;
  attempt: number;
  running: number;
  last_step: string | null;
  last_step_at: string | null;
  rework_count: number;
  updated_at: string;
};

export type LogRow = {
  id: number;
  delivery_id: string | null;
  from_state: string;
  event: string;
  to_effect: string | null;
  run: string | null;
  dropped_reason: string | null;
  mode: string;
  created_at: string;
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
export const REFRESH_SECONDS = 30;

const STATUS_COLUMNS = "owner, repo, issue_number, state, routine, attempt, running, last_step, last_step_at, rework_count, updated_at";
const PAGE = 100; // the list shows this many more per "Show more"
const MAX_SHOWN = 1000;
const MAX_ITEMS = 5000; // a safety cap on the grouped log; counts are exact below it

// Events that only happen on a pull request, to guess the kind of an item
// whose webhooks predate the items table.
const PR_EVENTS = [
  "labelled_auto_reworking",
  "unlabelled_auto_reworking",
  "rework_pushed",
  "ci_fix_pushed",
  "labelled_auto_merging",
  "unlabelled_auto_merging",
  "merge_gate_failed_soft",
  "merge_gate_failed_hard",
  "merged",
];
// A latest event that means it's closed, for the same older items.
const CLOSING_EVENTS = ["merged", "release_published", "issue_closed"];

/** The attached repos ("owner/repo", lowercased, sorted): REPO_ROUTINES_JSON's keys. */
export function attachedRepos(env: StatusEnv): string[] {
  try {
    return Object.keys(JSON.parse(env.REPO_ROUTINES_JSON ?? "{}") as Record<string, unknown>)
      .map((r) => r.toLowerCase())
      .sort();
  } catch {
    return [];
  }
}

/** The e2e sandbox repos (LOG_READ_REPOS), lowercased. */
export function sandboxRepos(env: StatusEnv): string[] {
  return (env.LOG_READ_REPOS ?? "")
    .split(",")
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
}

/** Real repos first, then the sandbox, each alphabetical. */
const orderRepos = (repos: string[], sandbox: string[]) => [...repos.filter((r) => !sandbox.includes(r)), ...repos.filter((r) => sandbox.includes(r))];

const pickRepo = (repos: string[], raw: string | null) => {
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
        kind: meta?.kind === "pr" || meta?.kind === "issue" ? meta.kind : a.pr_hint ? "pr" : null,
        title: meta?.title ?? null,
        closed,
        merged,
        ghOpen,
        known: !!meta,
        status: closed ? null : s,
        lastEvent: a.event,
        lastAt: a.last_at,
        events: a.events,
      };
    });
}

const needsAttention = (i: Item) => !!i.status && (tone(i.status.state) === "danger" || tone(i.status.state) === "warning");
const isOpen = (i: Item) => !i.closed && (!!i.status || i.ghOpen);

function matches(i: Item, f: Filters, skip?: "type" | "status"): boolean {
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

export async function handleStatus(request: Request, env: StatusEnv, url: URL, defer: Defer = () => {}): Promise<Response> {
  if (!env.STATUS_SECRET) return new Response("not found", { status: 404 });
  const script = request.headers.get("Authorization") === `Bearer ${env.STATUS_SECRET}`;
  const session = script ? null : await readSession(request, env);
  if (!script && !session) {
    if (!signInConfigured(env) || request.method !== "GET") return new Response("unauthorized", { status: 401 });
    const login = new URL("/auth/login", url);
    login.searchParams.set("next", url.pathname + url.search);
    return new Response(null, { status: 302, headers: { Location: login.pathname + login.search, "Cache-Control": "no-store" } });
  }
  const who = session?.login ?? "script";
  const user = session?.login;
  const sandbox = sandboxRepos(env);
  const repos = orderRepos(attachedRepos(env), sandbox);

  if (request.method === "POST" && url.pathname === "/status/controls") return handleSetControl(request, env, url, who, script, repos);
  if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
  if (url.pathname === "/status/repo") return repoPage(env, url, user, repos);
  if (url.pathname === "/status/issue") {
    // The old separate log page: now the list's panel.
    const repo = pickRepo(repos, url.searchParams.get("repo"));
    const n = Number(url.searchParams.get("n"));
    const to = repo && Number.isInteger(n) && n > 0 ? listHref(readFilters(new URL("https://x/"), repos), { open: { repo, n } }) : "/status";
    return new Response(null, { status: 301, headers: { Location: to } });
  }
  if (url.pathname !== "/status") return new Response("not found", { status: 404 });

  if (url.searchParams.get("format") === "json") {
    const { results } = await env.DB.prepare(`SELECT ${STATUS_COLUMNS} FROM issue_status ORDER BY running DESC, updated_at DESC LIMIT 500`).all<StatusRow>();
    return Response.json({ rows: results }, { headers: { "Cache-Control": "no-store" } });
  }

  const filters = readFilters(url, repos);
  const [activity, status, items] = await Promise.all([
    env.DB.prepare(
      `SELECT owner, repo, issue_number, event, created_at AS last_at, events, pr_hint FROM (
         SELECT LOWER(owner) AS owner, LOWER(repo) AS repo, issue_number, event, created_at,
                ROW_NUMBER() OVER w AS rn,
                COUNT(*) OVER p AS events,
                MAX(CASE WHEN event IN (${PR_EVENTS.map(() => "?").join(", ")}) THEN 1 ELSE 0 END) OVER p AS pr_hint
           FROM transitions
          WHERE issue_number > 0
         WINDOW p AS (PARTITION BY LOWER(owner), LOWER(repo), issue_number),
                w AS (PARTITION BY LOWER(owner), LOWER(repo), issue_number ORDER BY id DESC)
       ) WHERE rn = 1 ORDER BY last_at DESC LIMIT ${MAX_ITEMS}`,
    )
      .bind(...PR_EVENTS)
      .all<ActivityRow>(),
    env.DB.prepare(`SELECT ${STATUS_COLUMNS} FROM issue_status`).all<StatusRow>(),
    env.DB.prepare(`SELECT owner, repo, issue_number, kind, title, gh_state FROM items LIMIT ${MAX_ITEMS}`).all<ItemRow>(),
  ]);
  const all = buildItems(activity.results, status.results, items.results, repos);

  // Items whose webhooks all came before the items table: look the ones on
  // this page up on GitHub after responding, so the next refresh shows them.
  if (env.GITHUB_APP_TOKEN !== undefined) {
    const missing = visible(all, filters).filter((i) => !i.known).slice(0, BACKFILL_MAX);
    if (missing.length > 0) defer(backfillItems(env as GitHubEnv & { DB: D1Database }, missing));
  }

  let selected: { item: Item | null; log: LogRow[] } | null = null;
  if (filters.open) {
    const [owner, repo] = filters.open.repo.split("/") as [string, string];
    const log = await env.DB.prepare(
      `SELECT id, delivery_id, from_state, event, to_effect, run, dropped_reason, mode, created_at
         FROM transitions WHERE LOWER(owner) = ? AND LOWER(repo) = ? AND issue_number = ?
        ORDER BY id DESC LIMIT 300`,
    )
      .bind(owner, repo, filters.open.n)
      .all<LogRow>();
    selected = { item: all.find((i) => i.repo === filters.open!.repo && i.n === filters.open!.n) ?? null, log: log.results };
  }
  return html(renderDashboard({ items: all, filters, repos, sandbox, selected, now: Date.now(), user }));
}

// --- the repository page and its controls ------------------------------------

async function repoPage(env: StatusEnv, url: URL, user: string | undefined, repos: string[]): Promise<Response> {
  const full = pickRepo(repos, url.searchParams.get("repo"));
  if (!full) return html(layout({ title: "Repository", user, body: `<div class="box pad"><p class="lead">That isn't an attached repository.</p><a class="button secondary" href="/status">Back to the list</a></div>` }), 404);
  const [owner, repo] = full.split("/") as [string, string];
  const [controls, activity] = await Promise.all([
    controlsFor(env.DB, owner, repo),
    env.DB.prepare(
      `SELECT id, delivery_id, from_state, event, to_effect, run, dropped_reason, mode, created_at
         FROM transitions WHERE LOWER(owner) = ? AND LOWER(repo) = ? AND issue_number = 0
        ORDER BY id DESC LIMIT 50`,
    )
      .bind(owner, repo)
      .all<LogRow>(),
  ]);
  const enforced = env.SWEEP_MODE === "enforce" || (env.SWEEP_ENFORCE_REPOS ?? "").split(",").map((r) => r.trim().toLowerCase()).includes(full);
  return html(renderRepo(owner, repo, controls, enforced, Date.now(), user, url.searchParams.get("saved") === "1", activity.results));
}

async function handleSetControl(request: Request, env: StatusEnv, url: URL, who: string, script: boolean, repos: string[]): Promise<Response> {
  // A person's form must come from this page: a cross-site form post would
  // carry their session cookie (SameSite=Lax doesn't stop top-level POSTs
  // in every browser), but never this origin.
  if (!script && request.headers.get("Origin") !== url.origin) return new Response("forbidden", { status: 403 });
  const form = await request.formData().catch(() => null);
  const full = pickRepo(repos, String(form?.get("repo") ?? ""));
  const control = String(form?.get("control") ?? "");
  const enabled = String(form?.get("enabled") ?? "");
  if (!full || !isControl(control) || (enabled !== "0" && enabled !== "1")) return new Response("bad request", { status: 400 });
  const [owner, repo] = full.split("/") as [string, string];
  await setControl(env.DB, owner, repo, control, enabled === "1", who);
  const back = new URL("/status/repo", url);
  back.searchParams.set("repo", full);
  back.searchParams.set("saved", "1");
  return new Response(null, { status: 303, headers: { Location: back.pathname + back.search, "Cache-Control": "no-store" } });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // Inline styles and Lato from Google Fonts; forms post here only; no script.
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'",
    },
  });
}

// --- helpers -----------------------------------------------------------------

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** D1's datetime('now') ("YYYY-MM-DD HH:MM:SS", UTC) or an ISO string, as epoch ms. */
const toMs = (s: string) => Date.parse(s.includes("T") ? s : `${s.replace(" ", "T")}Z`);

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

/** DD-MM-YYYY HH:MM:SS UTC. */
export function when(at: string): string {
  const d = new Date(toMs(at));
  if (Number.isNaN(d.getTime())) return at;
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}

/** The portal's tag colour for a state: trouble, waiting on a person, or done. */
function tone(state: string): string {
  if (state === "ai-stuck" || state === "merge-blocked") return "danger";
  if (state === "ai-blocked") return "warning";
  if (state === "generated-by-ai") return "positive";
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

const githubHref = (repo: string, n: number) => `https://github.com/${repo.split("/").map(encodeURIComponent).join("/")}/issues/${n}`;

function stateTag(i: Item): string {
  if (i.status) return `<span class="tag ${tone(i.status.state)}">${escape(i.status.state)}</span>`;
  if (i.merged) return '<span class="tag positive">merged</span>';
  if (i.closed) return '<span class="tag quiet">closed</span>';
  return '<span class="tag quiet">not tracked</span>';
}

const titleText = (i: Item) =>
  i.title ? escape(i.title) : i.title === "" ? '<span class="muted">Not on GitHub any more</span>' : '<span class="muted">Title on its way</span>';

/** What the list shows, in its order, before paging. */
export function visible(items: Item[], f: Filters): Item[] {
  return items.filter((i) => matches(i, f)).sort((a, b) => rank(a) - rank(b) || toMs(b.lastAt) - toMs(a.lastAt));
}

/** A row's id, for the link that keeps it in view. */
const rowId = (i: { repo: string; n: number }) => `i-${i.repo.replace(/[^a-z0-9]+/g, "-")}-${i.n}`;

const kindTag = (i: Item) => (i.kind === "pr" ? '<span class="kind">PR</span>' : i.kind === "issue" ? '<span class="kind">Issue</span>' : '<span class="kind unknown">Issue or PR</span>');

// --- renders -----------------------------------------------------------------

function pill(label: string, count: number, href: string, current: boolean, extra = ""): string {
  return `<a class="pill" href="${escape(href)}"${current ? ' aria-current="true"' : ""}>${escape(label)}${extra} <span class="count">${count}</span></a>`;
}

export function renderDashboard(p: {
  items: Item[];
  filters: Filters;
  repos: string[];
  sandbox?: string[];
  selected: { item: Item | null; log: LogRow[] } | null;
  now: number;
  user?: string;
}): string {
  const { items, filters: f, repos, selected, now, user } = p;
  const sandbox = p.sandbox ?? [];
  const shown = visible(items, f);
  const byType = items.filter((i) => matches(i, f, "type"));
  const byStatus = items.filter((i) => matches(i, f, "status"));
  const inRepo = (r: string | null) => items.filter((i) => matches(i, { ...f, repo: r })).length;
  const e2eTag = ' <span class="e2e">e2e</span>';

  const typePills = [
    pill("All types", byType.length, listHref(f, { type: "all", open: null }), f.type === "all"),
    pill("Issues", byType.filter((i) => i.kind === "issue").length, listHref(f, { type: "issue", open: null }), f.type === "issue"),
    pill("Pull requests", byType.filter((i) => i.kind === "pr").length, listHref(f, { type: "pr", open: null }), f.type === "pr"),
  ].join("");
  const statusPills = [
    pill("Any status", byStatus.length, listHref(f, { status: "all", open: null }), f.status === "all"),
    pill("Open", byStatus.filter(isOpen).length, listHref(f, { status: "open", open: null }), f.status === "open"),
    pill("Running", byStatus.filter((i) => i.status?.running).length, listHref(f, { status: "running", open: null }), f.status === "running"),
    pill("Needs attention", byStatus.filter(needsAttention).length, listHref(f, { status: "attention", open: null }), f.status === "attention"),
    pill("Closed", byStatus.filter((i) => i.closed).length, listHref(f, { status: "closed", open: null }), f.status === "closed"),
  ].join("");
  const repoPills = [pill("All repositories", inRepo(null), listHref(f, { repo: null, open: null }), !f.repo)]
    .concat(repos.map((r) => pill(r, inRepo(r), listHref(f, { repo: r, open: null }), f.repo === r, sandbox.includes(r) ? e2eTag : "")))
    .join("");
  const hidden = (name: string, value: string | null) => (value ? `<input type="hidden" name="${name}" value="${escape(value)}">` : "");

  const panel = selected
    ? renderPanel(selected.item, f.open!, selected.log, now, f)
    : `<div class="box pad panel-empty"><p class="lead">Pick an issue or pull request to see its log.</p></div>`;

  const rows = shown
    .slice(0, f.limit)
    .map((i) => {
      const isSel = !!f.open && f.open.repo === i.repo && f.open.n === i.n;
      const routine = i.status?.routine
        ? `${escape(i.status.routine)}${i.status.attempt > 1 ? ` <span class="muted">· try ${i.status.attempt}</span>` : ""}`
        : "";
      // The link lands back on this row (#id), so the list keeps its place.
      const href = `${listHref(f, { open: isSel ? null : { repo: i.repo, n: i.n } })}#${rowId(i)}`;
      const row = `<a class="row${isSel ? " selected" : ""}" id="${rowId(i)}" href="${escape(href)}"${isSel ? ' aria-current="true" title="Close its log"' : ""}>
  <span class="row-main"><span class="num">#${i.n}</span> ${kindTag(i)} <span class="title">${titleText(i)}</span></span>
  <span class="row-meta">${stateTag(i)}${i.status?.running ? ' <span class="tag running"><span class="dot"></span>Running</span>' : ""}${routine ? ` <span class="routine">${routine}</span>` : ""}</span>
  <span class="row-sub">${escape(i.repo)}${sandbox.includes(i.repo) ? e2eTag : ""} · <code>${escape(i.lastEvent)}</code> · ${escape(ago(i.lastAt, now))}</span>
</a>`;
      // On a narrow screen the log opens under its row instead of beside the list.
      return isSel ? `${row}\n<div class="inline-log">${panel}</div>` : row;
    })
    .join("\n");
  const more = shown.length > f.limit
    ? `<a class="more" href="${escape(listHref(f, { limit: Math.min(f.limit + PAGE, MAX_SHOWN) }))}">Show ${Math.min(PAGE, shown.length - f.limit)} more of ${shown.length - f.limit}</a>`
    : "";

  return layout({
    title: "Orchestrator status",
    user,
    refresh: true,
    body: `<div class="section-title">
  <div><div class="eyebrow">Orchestrator · Live status</div><h1>Issues and pull requests</h1></div>
  <div class="refresh">Refreshes every ${REFRESH_SECONDS} seconds${f.repo ? ` · <a href="/status/repo?repo=${encodeURIComponent(f.repo)}">${escape(f.repo)} settings</a>` : ""}</div>
</div>
<div class="filters">
  <div class="pills" role="group" aria-label="Type">${typePills}</div>
  <div class="pills" role="group" aria-label="Status">${statusPills}</div>
  <div class="pills" role="group" aria-label="Repository">${repoPills}</div>
  <form class="lookup" method="get" action="/status">
    ${hidden("repo", f.repo)}${hidden("type", f.type === "all" ? null : f.type)}${hidden("status", f.status === "all" ? null : f.status)}
    <label class="sr" for="find-n">Issue or pull request number</label><input id="find-n" name="n" type="number" min="1" inputmode="numeric" placeholder="Find a number" value="${f.n ?? ""}">
    <button type="submit" class="secondary">Find</button>${f.n ? ` <a class="quiet" href="${escape(listHref(f, { n: null, open: null }))}">Clear</a>` : ""}
  </form>
</div>
<div class="split${selected ? " has-selection" : ""}">
  <div class="box list" aria-label="Issues and pull requests">
    ${rows || `<div class="empty">Nothing matches these filters.</div>`}
    ${more}
  </div>
  <div class="detail">${panel}</div>
</div>`,
  });
}

function renderPanel(item: Item | null, open: { repo: string; n: number }, log: LogRow[], now: number, f: Filters): string {
  const s = item?.status ?? null;
  const facts = s
    ? `<div class="facts">
  <div><div class="label">State</div>${stateTag(item!)}</div>
  <div><div class="label">Routine</div>${s.routine ? escape(s.routine) : "—"}${s.running ? ' <span class="tag running"><span class="dot"></span>Running</span>' : ""}</div>
  <div><div class="label">Attempt</div>${s.attempt || "—"}</div>
  <div><div class="label">Last step</div>${s.last_step ? `${escape(s.last_step)} <span class="sub">${escape(ago(s.last_step_at, now))}</span>` : "—"}</div>
  <div><div class="label">Reworks</div>${s.rework_count || "—"}</div>
</div>`
    : `<div class="facts"><div><div class="label">State</div>${item ? stateTag(item) : '<span class="tag quiet">not tracked</span>'}</div></div>`;
  const rows = log
    .map(
      (r) => `<tr>
  <td>${escape(when(r.created_at))}<div class="sub">${escape(ago(r.created_at, now))}</div></td>
  <td><code>${escape(r.event)}</code><div class="sub">from ${escape(r.from_state)}</div></td>
  <td>${escape(effectText(r.to_effect))}${r.dropped_reason ? `<div class="sub">${escape(r.dropped_reason)}</div>` : ""}</td>
  <td>${r.run ? escape(r.run) : '<span class="muted">—</span>'}</td>
  <td><span class="tag ${r.mode === "enforce" ? "default" : "quiet"}">${escape(r.mode)}</span><div class="sub">${r.delivery_id ? `delivery ${escape(r.delivery_id.slice(0, 8))}` : "no delivery"}</div></td>
</tr>`,
    )
    .join("\n");
  return `<div class="box panel">
  <div class="panel-head">
    <div>
      <div class="eyebrow">${escape(open.repo)} · ${item ? kindTag(item) : ""}</div>
      <h2>#${open.n}${item?.title ? ` ${escape(item.title)}` : ""}</h2>
    </div>
    <div class="panel-actions">
      <a class="button secondary" href="${escape(githubHref(open.repo, open.n))}">GitHub</a>
      <a class="button secondary" href="${escape(`${listHref(f, { open: null })}#${rowId(open)}`)}" aria-label="Close the log">Close</a>
    </div>
  </div>
  <div class="panel-facts">${facts}</div>
  <div class="panel-log-title">Transitions <span class="muted">(${log.length}${log.length === 300 ? ", newest 300" : ""}, newest first)</span></div>
  <div class="wrap">
  <table class="log">
  <thead><tr><th>When</th><th>Event</th><th>Effect</th><th>Routine</th><th>Mode</th></tr></thead>
  <tbody>
  ${rows || '<tr><td colspan="5" class="empty">Nothing logged.</td></tr>'}
  </tbody>
  </table>
  </div>
</div>`;
}

export function renderRepo(
  owner: string,
  repo: string,
  controls: { control: keyof typeof CONTROLS; enabled: boolean; row: { updated_by: string; updated_at: string } | null }[],
  sweepEnforced: boolean,
  now: number,
  signedInAs?: string,
  saved = false,
  activity: LogRow[] = [],
): string {
  const full = `${owner}/${repo}`;
  const items = controls
    .map(({ control, enabled, row }) => {
      const meta = CONTROLS[control];
      const changed = row ? `Changed by ${escape(row.updated_by)}, ${escape(ago(row.updated_at, now))}` : "Default: never changed";
      const mode = control === "sweep" ? `<div class="sub">When on, it ${sweepEnforced ? "re-fires (enforce)" : "only logs what it would re-fire (shadow)"} for this repository.</div>` : "";
      return `<div class="control">
  <div class="control-text">
    <div class="control-name">${escape(meta.name)} <span class="tag ${enabled ? "positive" : "quiet"}">${enabled ? "On" : "Off"}</span></div>
    <p>${escape(meta.about)}</p>${mode}
    <div class="sub">${changed}</div>
  </div>
  <form method="post" action="/status/controls">
    <input type="hidden" name="repo" value="${escape(full)}">
    <input type="hidden" name="control" value="${escape(control)}">
    <input type="hidden" name="enabled" value="${enabled ? "0" : "1"}">
    <button type="submit" class="${enabled ? "secondary" : ""}">${enabled ? "Turn off" : "Turn on"}</button>
  </form>
</div>`;
    })
    .join("\n");
  const log = activity
    .map(
      (r) => `<tr><td>${escape(when(r.created_at))}<div class="sub">${escape(ago(r.created_at, now))}</div></td><td><code>${escape(r.event)}</code></td><td>${escape(effectText(r.to_effect))}</td></tr>`,
    )
    .join("\n");
  return layout({
    title: `${full} · Orchestrator`,
    user: signedInAs,
    body: `<div class="crumbs"><a href="/status">Issues and pull requests</a> / <a href="/status?repo=${encodeURIComponent(full)}">${escape(full)}</a> / Settings</div>
<div class="section-title">
  <div><div class="eyebrow">Repository settings</div><h1>${escape(full)}</h1></div>
  <a class="button secondary" href="/status?repo=${encodeURIComponent(full)}">View its issues and PRs</a>
</div>
${saved ? '<div class="banner" role="status">Saved. The change is logged under repository activity.</div>' : ""}
<div class="box">${items}</div>
<p class="sub below-small">More controls arrive here as agents and routines get their own switches.</p>
<h2>Repository activity</h2>
<div class="box table-box"><div class="wrap"><table>
<thead><tr><th>When</th><th>Event</th><th>What</th></tr></thead>
<tbody>${log || '<tr><td colspan="3" class="empty">Nothing yet.</td></tr>'}</tbody>
</table></div></div>`,
  });
}

// --- the shared layout ------------------------------------------------------

// The Umbraco logo mark, from the Cloud Portal design system's assets.
const LOGO_MARK =
  '<svg viewBox="0 0 40 40" width="28" height="28" aria-hidden="true"><path fill="currentColor" d="M0,20C0,8.9,9,0,20,0s20,9,20,20s-9,20-20,20C8.9,40,0,31,0,20L0,20z M19.6,26.8c-1.6,0-3.1-0.1-4.6-0.4c-1.1-0.2-2.1-1-2.5-2c-0.5-1-0.7-2.6-0.7-4.8c0-1.1,0.1-2.3,0.2-3.4c0.1-1.1,0.3-2,0.4-2.7l0.1-0.7c0,0,0,0,0-0.1c0-0.2-0.1-0.4-0.3-0.4l-2.6-0.4H9.6c-0.2,0-0.4,0.1-0.4,0.3c0,0.2-0.1,0.3-0.1,0.7c-0.1,0.8-0.3,1.5-0.4,2.6c-0.2,1.2-0.3,2.4-0.3,3.5c-0.1,0.8-0.1,1.6,0,2.5c0.1,2.2,0.4,3.9,1.1,5.2c0.7,1.3,1.9,2.2,3.5,2.8c1.6,0.6,3.9,0.9,6.9,0.8h0.4c2.9,0,5.2-0.3,6.9-0.8c1.6-0.6,2.8-1.5,3.5-2.8c0.7-1.3,1.1-3.1,1.1-5.2c0.1-0.8,0.1-1.6,0-2.5c0-1.2-0.1-2.4-0.3-3.5c-0.1-1.1-0.3-1.8-0.4-2.6c-0.1-0.4-0.1-0.5-0.1-0.7c0-0.2-0.2-0.3-0.4-0.3h-0.1l-2.6,0.4c-0.2,0-0.3,0.2-0.3,0.4c0,0,0,0,0,0.1l0.1,0.7c0.1,0.7,0.3,1.6,0.4,2.7c0.1,1.1,0.2,2.3,0.2,3.4c0,2.2-0.2,3.8-0.7,4.8c-0.5,1-1.4,1.8-2.5,2c-1.5,0.3-3.1,0.5-4.6,0.4L19.6,26.8z"/></svg>';

// Styled to the Umbraco Cloud Portal design system (its colors_and_type.css
// tokens and component previews): the navy top bar, white-lilac page, 12px
// bordered boxes, the portal's tables, tags, buttons and inputs, Lato. Light
// only, as the portal is.
function layout({ title, user, body, refresh = false }: { title: string; user?: string; body: string; refresh?: boolean }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh ? `<meta http-equiv="refresh" content="${REFRESH_SECONDS}">\n` : ""}<title>${escape(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lato:wght@400;700;900&display=swap">
<style>
:root {
  --ucp-color-header-surface: #1b264f; --ucp-color-background: #f7f8fc; --ucp-color-surface: #ffffff;
  --ucp-color-text: #030229; --ucp-color-text-alt: #707b81;
  --ucp-color-divider: #e9edf7; --ucp-color-row-divider: #f0f2f8; --ucp-palette-soft-blue: #cdd7ee;
  --ucp-color-interactive: #1b264f; --ucp-color-interactive-emphasis: #1e2e7a; --ucp-color-default-standalone: #151e3f; --ucp-color-focus: #4f64ff;
  --ucp-palette-dawn-pink: #fae9e8; --ucp-palette-primary-pink: #f5c1bc;
  --ucp-color-positive: #25aa60; --ucp-color-warning: #fad634; --ucp-color-danger: #d22d56;
  --ucp-border-radius-small: 3px; --ucp-border-radius-medium: 6px; --ucp-border-radius-large: 12px;
  --ucp-shadow-depth-1: 0 6px 5px -4px rgba(0, 0, 0, 0.05);
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--ucp-color-background); color: var(--ucp-color-text); font: 15px/1.6 Lato, "Helvetica Neue", Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; }
.top-bar { height: 62px; background: var(--ucp-color-header-surface); color: #fff; display: flex; align-items: center; gap: 12px; padding: 0 24px; }
.top-bar .home { color: #fff; display: flex; }
.top-bar .product { font-size: 15px; font-weight: 700; }
.top-bar .product span { font-weight: 400; color: rgba(255, 255, 255, 0.7); }
.top-bar .user { margin-left: auto; font-size: 13px; color: rgba(255, 255, 255, 0.8); display: flex; align-items: center; gap: 12px; }
.top-bar .user a { color: #fff; font-weight: 700; padding: 6px 12px; border-radius: var(--ucp-border-radius-medium); }
.top-bar .user a:hover { background: #2a3360; text-decoration: none; color: #fff; }
main { width: min(100%, 1600px); margin: 0 auto; padding: 30px 50px 50px; }
.repos { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 24px; }
.repos a { font-size: 13px; padding: 6px 12px; border-radius: var(--ucp-border-radius-medium); background: var(--ucp-color-surface); border: 1px solid var(--ucp-color-divider); color: var(--ucp-color-interactive); }
.repos a:hover { background: var(--ucp-palette-dawn-pink); text-decoration: none; }
.repos a[aria-current="page"] { background: var(--ucp-palette-dawn-pink); border-color: var(--ucp-palette-primary-pink); box-shadow: inset 3px 0 0 var(--ucp-palette-primary-pink); }
.repos .count { font-weight: 400; color: var(--ucp-color-text-alt); margin-left: 4px; }
.crumbs { font-size: 13px; color: var(--ucp-color-text-alt); margin-bottom: 12px; }
.crumbs a { font-weight: 400; }
.section-title { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 18px; }
.eyebrow { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: var(--ucp-color-text-alt); margin-bottom: 4px; }
h1 { margin: 0; font-size: 30px; font-weight: 700; line-height: 1.25; letter-spacing: -.005em; overflow-wrap: anywhere; }
h2 { font-size: 21px; font-weight: 700; margin: 30px 0 12px; }
.refresh { font-size: 12px; color: var(--ucp-color-text-alt); }
.stats { display: grid; grid-template-columns: repeat(3, minmax(0, 220px)); gap: 18px; margin-bottom: 24px; }
.box { background: var(--ucp-color-surface); border: 1px solid var(--ucp-color-divider); border-radius: var(--ucp-border-radius-large); box-shadow: var(--ucp-shadow-depth-1); }
.box.pad { padding: 24px 30px; }
.stat { padding: 18px 20px; }
.stat-title { font-size: 13px; font-weight: 700; color: var(--ucp-color-interactive); }
.stat-value { font-size: 28px; font-weight: 900; color: var(--ucp-color-interactive); letter-spacing: -.01em; line-height: 1.2; margin-top: 6px; }
.facts { display: flex; flex-wrap: wrap; gap: 30px; }
.facts .label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--ucp-color-text-alt); margin-bottom: 4px; }
.lead { margin: 0 0 12px; color: var(--ucp-color-text-alt); }
.table-box { overflow: hidden; }
.wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; min-width: 820px; font-size: 14px; }
thead tr { background: var(--ucp-color-background); }
th { text-align: left; padding: 14px 22px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--ucp-color-text-alt); border-bottom: 1px solid var(--ucp-color-divider); }
td { padding: 12px 22px; border-bottom: 1px solid var(--ucp-color-row-divider); vertical-align: top; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr { transition: background-color .15s; }
tbody tr:hover { background: var(--ucp-palette-dawn-pink); }
th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
a { color: var(--ucp-color-interactive); font-weight: 700; text-decoration: none; transition: color .15s; }
a:hover { color: var(--ucp-color-interactive-emphasis); text-decoration: underline; }
a.quiet { font-weight: 400; color: var(--ucp-color-text-alt); }
:focus-visible { outline: 2px solid var(--ucp-color-focus); outline-offset: 2px; border-radius: var(--ucp-border-radius-small); }
.sub { font-size: 12px; color: var(--ucp-color-text-alt); }
.muted { color: var(--ucp-color-text-alt); font-weight: 400; }
.tag { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; letter-spacing: .01em; padding: 3px 8px; border-radius: var(--ucp-border-radius-small); border: 1px solid transparent; white-space: nowrap; vertical-align: middle; }
.tag .dot { width: 6px; height: 6px; border-radius: 50%; }
.tag.default { background: var(--ucp-color-background); color: var(--ucp-color-interactive); border-color: var(--ucp-palette-soft-blue); }
.tag.quiet { background: #f3f3f5; color: #5d6670; }
.tag.positive { background: #e3f6ec; color: #1e8a50; }
.tag.warning { background: #fef5d6; color: #8a7516; }
.tag.danger { background: #fbe4eb; color: #a82547; }
.tag.running { background: var(--ucp-color-positive); color: #fff; margin-left: 6px; }
.tag.running .dot { background: #fff; }
.empty { padding: 36px 22px; text-align: center; color: var(--ucp-color-text-alt); }
.below { margin-top: 30px; }
.below-small { margin-top: 12px; }
.filters { display: flex; flex-direction: column; gap: 9px; margin-bottom: 18px; }
.pills { display: flex; flex-wrap: wrap; gap: 6px; }
.pill { font-size: 13px; padding: 4px 12px; border-radius: 999px; background: var(--ucp-color-surface); border: 1px solid var(--ucp-color-divider); color: var(--ucp-color-interactive); white-space: nowrap; }
.pill:hover { background: var(--ucp-palette-dawn-pink); text-decoration: none; }
.pill .count { font-weight: 400; color: var(--ucp-color-text-alt); margin-left: 3px; }
.pill[aria-current] { background: var(--ucp-color-interactive); border-color: var(--ucp-color-interactive); color: #fff; }
.pill[aria-current] .count { color: rgba(255, 255, 255, 0.75); }
.filters .lookup { margin-top: 3px; }
.split { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); gap: 18px; align-items: start; }
.list { overflow: hidden; }
.row { display: grid; gap: 3px; padding: 12px 18px; border-bottom: 1px solid var(--ucp-color-row-divider); color: var(--ucp-color-text); font-weight: 400; transition: background-color .15s; }
.row:last-child { border-bottom: 0; }
.row:hover { background: var(--ucp-palette-dawn-pink); text-decoration: none; color: var(--ucp-color-text); }
.row.selected { background: var(--ucp-palette-dawn-pink); box-shadow: inset 3px 0 0 var(--ucp-palette-primary-pink); }
.row-main { display: flex; gap: 8px; align-items: baseline; min-width: 0; }
.row-main .num { font-weight: 700; color: var(--ucp-color-interactive); }
.row-main .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 13px; }
.row-meta .routine { color: var(--ucp-color-text-alt); }
.row-sub { font-size: 12px; color: var(--ucp-color-text-alt); overflow-wrap: anywhere; }
.row-sub code { font-size: 12px; }
.kind { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--ucp-color-text-alt); border: 1px solid var(--ucp-color-divider); border-radius: var(--ucp-border-radius-small); padding: 0 5px; white-space: nowrap; }
.detail { position: sticky; top: 18px; max-height: calc(100vh - 36px); overflow-y: auto; border-radius: var(--ucp-border-radius-large); }
.inline-log { display: none; }
.e2e { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #8a7516; background: #fef5d6; border-radius: var(--ucp-border-radius-small); padding: 0 5px; margin-left: 4px; }
.more { display: block; padding: 14px 18px; text-align: center; border-top: 1px solid var(--ucp-color-row-divider); }
.row { scroll-margin-top: 12px; }
.panel { overflow: hidden; }
.panel-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding: 18px 22px; border-bottom: 1px solid var(--ucp-color-divider); }
.panel-head h2 { margin: 0; font-size: 21px; overflow-wrap: anywhere; }
.panel-actions { display: flex; gap: 6px; flex-shrink: 0; }
.panel-facts { padding: 18px 22px; border-bottom: 1px solid var(--ucp-color-divider); }
.panel-log-title { padding: 14px 22px 6px; font-weight: 700; }
table.log { min-width: 560px; }
.panel-empty { text-align: center; }
.button, button { display: inline-flex; align-items: center; height: 36px; padding: 0 18px; border-radius: var(--ucp-border-radius-medium); font: 700 14px Lato, "Helvetica Neue", Helvetica, Arial, sans-serif; background: var(--ucp-color-interactive); color: #fff; border: 1px solid var(--ucp-color-interactive); cursor: pointer; transition: background-color .15s, box-shadow .15s; }
.button:hover, button:hover { background: var(--ucp-color-default-standalone); color: #fff; text-decoration: none; box-shadow: var(--ucp-shadow-depth-1); }
.button.secondary, button.secondary { background: var(--ucp-color-surface); color: var(--ucp-color-interactive); border-color: var(--ucp-palette-soft-blue); }
.button.secondary:hover, button.secondary:hover { background: var(--ucp-palette-dawn-pink); color: var(--ucp-color-interactive); }
.lookup { display: flex; flex-wrap: wrap; gap: 9px; align-items: center; }
select, input { height: 36px; padding: 0 12px; border: 1px solid var(--ucp-palette-soft-blue); border-radius: var(--ucp-border-radius-medium); background: var(--ucp-color-surface); color: var(--ucp-color-text); font: 14px Lato, "Helvetica Neue", Helvetica, Arial, sans-serif; }
input { width: 180px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.control { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; padding: 24px 30px; border-bottom: 1px solid var(--ucp-color-row-divider); }
.control:last-child { border-bottom: 0; }
.control-name { font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 9px; }
.control p { margin: 4px 0; max-width: 640px; }
.banner { background: #e3f6ec; color: #1e8a50; border-radius: var(--ucp-border-radius-medium); padding: 9px 15px; margin-bottom: 18px; font-weight: 700; font-size: 14px; }
@media (max-width: 1100px) {
  .split { grid-template-columns: 1fr; }
  .detail { display: none; }
  .inline-log { display: block; padding: 0 9px 12px; background: var(--ucp-palette-dawn-pink); border-bottom: 1px solid var(--ucp-color-row-divider); }
  .inline-log .box { box-shadow: none; }
}
@media (max-width: 700px) {
  main { padding: 24px 16px 36px; }
  .top-bar { padding: 0 16px; }
  .top-bar .product span { display: none; }
  .stats { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 9px; }
  .stat { padding: 12px; }
  .box.pad, .control { padding: 18px; }
  .control { flex-direction: column; }
  th, td { padding: 10px 14px; }
  input { width: 100%; }
}
</style>
</head>
<body>
<header class="top-bar"><a class="home" href="/status" aria-label="Issues and pull requests">${LOGO_MARK}</a><div class="product">Agent orchestrator <span>/ Live status</span></div>${
    user ? `<div class="user">${escape(user)}<a href="/auth/logout">Sign out</a></div>` : ""
  }</header>
<main>
${body}
</main>
</body>
</html>`;
}
