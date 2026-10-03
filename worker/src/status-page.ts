// The dashboard (03-components.md §3.6), all under /status. Off unless
// STATUS_SECRET is set. People sign in with GitHub (auth.ts: a verified
// Umbraco email); scripts send `Authorization: Bearer <STATUS_SECRET>`.
//
// - GET /status[?repo=o/r]: open issues from issue_status (migrations/0004),
//   across the attached repos or one of them; ?format=json gives the rows
// - GET /status/issue?repo=o/r&n=N: one issue's transition log from D1
// - GET /status/repo?repo=o/r: a repo's controls (controls.ts), e.g. its sweep
// - POST /status/controls: switches one (same origin only)
//
// Server-rendered, no script; the overview and issue pages reload themselves
// every REFRESH_SECONDS.

import { readSession, signInConfigured, type AuthEnv } from "./auth";
import { CONTROLS, controlsFor, isControl, setControl } from "./controls";

export type StatusEnv = AuthEnv & {
  DB: D1Database;
  STATUS_SECRET?: string;
  // Only its keys are read here: the attached repos.
  REPO_ROUTINES_JSON?: string;
  SWEEP_MODE?: string;
  SWEEP_ENFORCE_REPOS?: string;
};

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

/** How often the overview and issue pages reload themselves (a meta refresh: no script needed). */
export const REFRESH_SECONDS = 30;

const STATUS_COLUMNS = "owner, repo, issue_number, state, routine, attempt, running, last_step, last_step_at, rework_count, updated_at";

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

/** "owner/repo", if it's an attached repo, split; else null. */
function pickRepo(env: StatusEnv, raw: string | null): [string, string] | null {
  const want = (raw ?? "").toLowerCase();
  if (!attachedRepos(env).includes(want)) return null;
  const [owner, repo] = want.split("/") as [string, string];
  return [owner, repo];
}

export async function handleStatus(request: Request, env: StatusEnv, url: URL): Promise<Response> {
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

  if (request.method === "POST" && url.pathname === "/status/controls") return handleSetControl(request, env, url, who, script);
  if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
  if (url.pathname === "/status/issue") return issuePage(env, url, user);
  if (url.pathname === "/status/repo") return repoPage(env, url, user);
  if (url.pathname !== "/status") return new Response("not found", { status: 404 });

  const { results } = await env.DB.prepare(`SELECT ${STATUS_COLUMNS} FROM issue_status ORDER BY running DESC, updated_at DESC LIMIT 500`).all<StatusRow>();
  if (url.searchParams.get("format") === "json") {
    return Response.json({ rows: results }, { headers: { "Cache-Control": "no-store" } });
  }
  const picked = pickRepo(env, url.searchParams.get("repo"));
  return html(renderStatus(results, Date.now(), user, { repos: attachedRepos(env), current: picked ? picked.join("/") : null }));
}

// --- the pages ---------------------------------------------------------------

async function issuePage(env: StatusEnv, url: URL, user?: string): Promise<Response> {
  const picked = pickRepo(env, url.searchParams.get("repo"));
  const n = Number(url.searchParams.get("n"));
  if (!picked || !Number.isInteger(n) || n <= 0) {
    return html(layout({ title: "Issue log", user, body: notice("Pick an attached repository and an issue or pull request number.", attachedRepos(env)) }), 400);
  }
  const [owner, repo] = picked;
  const [status, log] = await Promise.all([
    env.DB.prepare(`SELECT ${STATUS_COLUMNS} FROM issue_status WHERE owner = ? AND repo = ? AND issue_number = ?`).bind(owner, repo, n).first<StatusRow>(),
    env.DB.prepare(
      `SELECT id, delivery_id, from_state, event, to_effect, run, dropped_reason, mode, created_at
         FROM transitions
        WHERE LOWER(owner) = ? AND LOWER(repo) = ? AND issue_number = ?
        ORDER BY id DESC LIMIT 500`,
    )
      .bind(owner, repo, n)
      .all<LogRow>(),
  ]);
  return html(renderIssue(owner, repo, n, status, log.results, Date.now(), user, attachedRepos(env)));
}

async function repoPage(env: StatusEnv, url: URL, user?: string): Promise<Response> {
  const picked = pickRepo(env, url.searchParams.get("repo"));
  if (!picked) return html(layout({ title: "Repository", user, body: notice("That isn't an attached repository.", attachedRepos(env)) }), 404);
  const [owner, repo] = picked;
  const controls = await controlsFor(env.DB, owner, repo);
  const enforced = env.SWEEP_MODE === "enforce" || (env.SWEEP_ENFORCE_REPOS ?? "").split(",").map((r) => r.trim().toLowerCase()).includes(`${owner}/${repo}`);
  return html(renderRepo(owner, repo, controls, enforced, Date.now(), user, url.searchParams.get("saved") === "1"));
}

async function handleSetControl(request: Request, env: StatusEnv, url: URL, who: string, script: boolean): Promise<Response> {
  // A person's form must come from this page: a cross-site form post would
  // carry their session cookie (SameSite=Lax doesn't stop top-level POSTs
  // in every browser), but never this origin.
  if (!script && request.headers.get("Origin") !== url.origin) return new Response("forbidden", { status: 403 });
  const form = await request.formData().catch(() => null);
  const picked = pickRepo(env, String(form?.get("repo") ?? ""));
  const control = String(form?.get("control") ?? "");
  const enabled = String(form?.get("enabled") ?? "");
  if (!picked || !isControl(control) || (enabled !== "0" && enabled !== "1")) return new Response("bad request", { status: 400 });
  await setControl(env.DB, picked[0], picked[1], control, enabled === "1", who);
  const back = new URL("/status/repo", url);
  back.searchParams.set("repo", picked.join("/"));
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
    const e = JSON.parse(toEffect) as { kind?: string; value?: string; change?: string; control?: string; enabled?: boolean; held?: string };
    if (e.kind === "label" && e.value) return `→ ${e.value}`;
    if (e.kind === "unlabel") return "label removed";
    if (e.kind === "close") return "closed";
    if (e.kind === "manual" && e.change) return `by hand: ${e.change}`;
    if (e.kind === "noop") return e.held ? `nothing (held: ${e.held})` : "no change";
    return toEffect;
  } catch {
    return toEffect;
  }
}

const issueHref = (repo: string, n: number) => `/status/issue?repo=${encodeURIComponent(repo)}&n=${n}`;
const githubHref = (repo: string, n: number) => `https://github.com/${repo.split("/").map(encodeURIComponent).join("/")}/issues/${n}`;

function lookupForm(repos: string[], current?: string, n?: number): string {
  if (repos.length === 0) return "";
  const options = repos.map((r) => `<option value="${escape(r)}"${r === current ? " selected" : ""}>${escape(r)}</option>`).join("");
  return `<form class="lookup" method="get" action="/status/issue">
  <label class="sr" for="lookup-repo">Repository</label><select id="lookup-repo" name="repo">${options}</select>
  <label class="sr" for="lookup-n">Issue or pull request number</label><input id="lookup-n" name="n" type="number" min="1" inputmode="numeric" placeholder="Issue or PR number" value="${n ?? ""}" required>
  <button type="submit">Show log</button>
</form>`;
}

function notice(message: string, repos: string[]): string {
  return `<div class="box pad"><p class="lead">${escape(message)}</p>${lookupForm(repos)}</div>`;
}

// --- renders -----------------------------------------------------------------

export function renderStatus(rows: StatusRow[], now: number, signedInAs?: string, nav: { repos: string[]; current: string | null } = { repos: [], current: null }): string {
  const key = (r: StatusRow) => `${r.owner}/${r.repo}`;
  const shown = nav.current ? rows.filter((r) => key(r) === nav.current) : rows;
  const running = shown.filter((r) => r.running).length;
  const stuck = shown.filter((r) => tone(r.state) === "danger" || tone(r.state) === "warning").length;
  const count = (repo: string) => rows.filter((r) => key(r) === repo).length;
  const tabs = nav.repos.length
    ? `<nav class="repos" aria-label="Repositories">
  <a href="/status"${nav.current ? "" : ' aria-current="page"'}>All repositories <span class="count">${rows.length}</span></a>
  ${nav.repos.map((r) => `<a href="/status?repo=${encodeURIComponent(r)}"${r === nav.current ? ' aria-current="page"' : ""}>${escape(r)} <span class="count">${count(r)}</span></a>`).join("\n  ")}
</nav>`
    : "";
  const body = shown
    .map((r) => {
      const repo = key(r);
      const step = r.last_step ? `${escape(r.last_step)}<div class="sub">${escape(ago(r.last_step_at, now))}</div>` : `<span class="muted">—</span>`;
      return `<tr>
  <td><a href="${escape(issueHref(repo, r.issue_number))}">#${r.issue_number}</a><div class="sub">${escape(repo)} · <a class="quiet" href="${escape(githubHref(repo, r.issue_number))}">GitHub</a></div></td>
  <td><span class="tag ${tone(r.state)}">${escape(r.state)}</span></td>
  <td>${r.routine ? escape(r.routine) : '<span class="muted">—</span>'}${r.running ? ' <span class="tag running"><span class="dot"></span>Running</span>' : ""}</td>
  <td class="num">${r.attempt || ""}</td>
  <td>${step}</td>
  <td class="num">${r.rework_count || ""}</td>
  <td class="muted">${escape(ago(r.updated_at, now))}</td>
</tr>`;
    })
    .join("\n");
  const title = nav.current ?? "Open issues";
  const side = nav.current
    ? `<a class="button secondary" href="/status/repo?repo=${encodeURIComponent(nav.current)}">Repository settings</a>`
    : `<div class="refresh">Refreshes every ${REFRESH_SECONDS} seconds</div>`;
  return layout({
    title: "Orchestrator status",
    user: signedInAs,
    refresh: true,
    body: `${tabs}
<div class="section-title">
  <div><div class="eyebrow">${nav.current ? "Repository · Open issues" : "Orchestrator · Live status"}</div><h1>${escape(title)}</h1></div>
  ${side}
</div>
<div class="stats">
  <div class="box stat"><div class="stat-title">Tracked</div><div class="stat-value">${shown.length}</div></div>
  <div class="box stat"><div class="stat-title">Running</div><div class="stat-value">${running}</div></div>
  <div class="box stat"><div class="stat-title">Stuck or blocked</div><div class="stat-value">${stuck}</div></div>
</div>
<div class="box table-box">
<div class="wrap">
<table>
<thead><tr><th>Issue</th><th>State</th><th>Routine</th><th class="num">Attempt</th><th>Last step</th><th class="num">Reworks</th><th>Updated</th></tr></thead>
<tbody>
${body || '<tr><td colspan="7" class="empty">Nothing tracked right now.</td></tr>'}
</tbody>
</table>
</div>
</div>
<div class="below"><h2>Look up an issue's log</h2>${lookupForm(nav.repos, nav.current ?? undefined)}</div>`,
  });
}

export function renderIssue(owner: string, repo: string, n: number, status: StatusRow | null, log: LogRow[], now: number, signedInAs?: string, repos: string[] = []): string {
  const full = `${owner}/${repo}`;
  const current = status
    ? `<div class="facts">
  <div><div class="label">State</div><span class="tag ${tone(status.state)}">${escape(status.state)}</span></div>
  <div><div class="label">Routine</div>${status.routine ? escape(status.routine) : "—"}${status.running ? ' <span class="tag running"><span class="dot"></span>Running</span>' : ""}</div>
  <div><div class="label">Attempt</div>${status.attempt || "—"}</div>
  <div><div class="label">Last step</div>${status.last_step ? `${escape(status.last_step)} <span class="sub">${escape(ago(status.last_step_at, now))}</span>` : "—"}</div>
  <div><div class="label">Reworks</div>${status.rework_count || "—"}</div>
</div>`
    : `<p class="lead">Not tracked right now: closed, or nothing enforced has happened to it since the dashboard began.</p>`;
  const rows = log
    .map(
      (r) => `<tr>
  <td>${escape(when(r.created_at))}<div class="sub">${escape(ago(r.created_at, now))}</div></td>
  <td><code>${escape(r.event)}</code></td>
  <td>${escape(r.from_state)}</td>
  <td>${escape(effectText(r.to_effect))}</td>
  <td>${r.run ? escape(r.run) : '<span class="muted">—</span>'}</td>
  <td><span class="tag ${r.mode === "enforce" ? "default" : "quiet"}">${escape(r.mode)}</span></td>
  <td>${r.dropped_reason ? `<span class="muted">${escape(r.dropped_reason)}</span>` : ""}<div class="sub">${r.delivery_id ? `delivery ${escape(r.delivery_id.slice(0, 8))}` : "no delivery"}</div></td>
</tr>`,
    )
    .join("\n");
  return layout({
    title: `${full}#${n} · Orchestrator`,
    user: signedInAs,
    refresh: true,
    body: `<div class="crumbs"><a href="/status">Open issues</a> / <a href="/status?repo=${encodeURIComponent(full)}">${escape(full)}</a> / #${n}</div>
<div class="section-title">
  <div><div class="eyebrow">Issue log</div><h1>${escape(full)}#${n}</h1></div>
  <a class="button secondary" href="${escape(githubHref(full, n))}">Open on GitHub</a>
</div>
<div class="box pad">${current}</div>
<h2>Transitions <span class="muted">(${log.length}${log.length === 500 ? ", newest 500" : ""}, newest first)</span></h2>
<div class="box table-box">
<div class="wrap">
<table>
<thead><tr><th>When</th><th>Event</th><th>From</th><th>Effect</th><th>Routine</th><th>Mode</th><th>Note</th></tr></thead>
<tbody>
${rows || '<tr><td colspan="7" class="empty">Nothing logged for this issue.</td></tr>'}
</tbody>
</table>
</div>
</div>
<div class="below"><h2>Look up another</h2>${lookupForm(repos, full)}</div>`,
  });
}

export function renderRepo(
  owner: string,
  repo: string,
  controls: { control: keyof typeof CONTROLS; enabled: boolean; row: { updated_by: string; updated_at: string } | null }[],
  sweepEnforced: boolean,
  now: number,
  signedInAs?: string,
  saved = false,
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
  return layout({
    title: `${full} · Orchestrator`,
    user: signedInAs,
    body: `<div class="crumbs"><a href="/status">Open issues</a> / <a href="/status?repo=${encodeURIComponent(full)}">${escape(full)}</a> / Settings</div>
<div class="section-title">
  <div><div class="eyebrow">Repository settings</div><h1>${escape(full)}</h1></div>
  <a class="button secondary" href="/status?repo=${encodeURIComponent(full)}">View open issues</a>
</div>
${saved ? '<div class="banner" role="status">Saved. The change is logged as a <code>control_changed</code> row.</div>' : ""}
<div class="box">${items}</div>
<p class="sub below">More controls arrive here as agents and routines get their own switches.</p>`,
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
<header class="top-bar"><a class="home" href="/status" aria-label="Open issues">${LOGO_MARK}</a><div class="product">Agent orchestrator <span>/ Live status</span></div>${
    user ? `<div class="user">${escape(user)}<a href="/auth/logout">Sign out</a></div>` : ""
  }</header>
<main>
${body}
</main>
</body>
</html>`;
}
