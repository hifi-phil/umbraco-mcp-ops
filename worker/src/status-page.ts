// GET /status: the live-status dashboard (03-components.md §3.6). A thin,
// read-only render of the issue_status table (migrations/0004), reloading
// itself every REFRESH_SECONDS, no push. Off unless STATUS_SECRET is set.
// People sign in with GitHub (auth.ts: a verified Umbraco email); scripts
// send `Authorization: Bearer <STATUS_SECRET>`. ?format=json returns the
// rows instead.

import { readSession, signInConfigured, type AuthEnv } from "./auth";

export type StatusEnv = AuthEnv & { DB: D1Database; STATUS_SECRET?: string };

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

export async function handleStatus(request: Request, env: StatusEnv, url: URL): Promise<Response> {
  if (!env.STATUS_SECRET) return new Response("not found", { status: 404 });
  const script = request.headers.get("Authorization") === `Bearer ${env.STATUS_SECRET}`;
  const session = script ? null : await readSession(request, env);
  if (!script && !session) {
    if (!signInConfigured(env)) return new Response("unauthorized", { status: 401 });
    const login = new URL("/auth/login", url);
    login.searchParams.set("next", url.pathname + url.search);
    return new Response(null, { status: 302, headers: { Location: login.pathname + login.search, "Cache-Control": "no-store" } });
  }
  const { results } = await env.DB.prepare(
    `SELECT owner, repo, issue_number, state, routine, attempt, running, last_step, last_step_at, rework_count, updated_at
       FROM issue_status
      ORDER BY running DESC, updated_at DESC
      LIMIT 500`,
  ).all<StatusRow>();
  if (url.searchParams.get("format") === "json") {
    return Response.json({ rows: results }, { headers: { "Cache-Control": "no-store" } });
  }
  return new Response(renderStatus(results, Date.now(), session?.login), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // Inline styles and Lato from Google Fonts; nothing else, and no script.
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com",
    },
  });
}

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

/** The portal's tag colour for a state: trouble, waiting on a person, or done. */
function tone(state: string): string {
  if (state === "ai-stuck" || state === "merge-blocked") return "danger";
  if (state === "ai-blocked") return "warning";
  if (state === "generated-by-ai") return "positive";
  return "default";
}

/** How often the page reloads itself (a meta refresh: no script needed). */
export const REFRESH_SECONDS = 30;

// The Umbraco logo mark, from the Cloud Portal design system's assets.
const LOGO_MARK =
  '<svg viewBox="0 0 40 40" width="28" height="28" aria-hidden="true"><path fill="currentColor" d="M0,20C0,8.9,9,0,20,0s20,9,20,20s-9,20-20,20C8.9,40,0,31,0,20L0,20z M19.6,26.8c-1.6,0-3.1-0.1-4.6-0.4c-1.1-0.2-2.1-1-2.5-2c-0.5-1-0.7-2.6-0.7-4.8c0-1.1,0.1-2.3,0.2-3.4c0.1-1.1,0.3-2,0.4-2.7l0.1-0.7c0,0,0,0,0-0.1c0-0.2-0.1-0.4-0.3-0.4l-2.6-0.4H9.6c-0.2,0-0.4,0.1-0.4,0.3c0,0.2-0.1,0.3-0.1,0.7c-0.1,0.8-0.3,1.5-0.4,2.6c-0.2,1.2-0.3,2.4-0.3,3.5c-0.1,0.8-0.1,1.6,0,2.5c0.1,2.2,0.4,3.9,1.1,5.2c0.7,1.3,1.9,2.2,3.5,2.8c1.6,0.6,3.9,0.9,6.9,0.8h0.4c2.9,0,5.2-0.3,6.9-0.8c1.6-0.6,2.8-1.5,3.5-2.8c0.7-1.3,1.1-3.1,1.1-5.2c0.1-0.8,0.1-1.6,0-2.5c0-1.2-0.1-2.4-0.3-3.5c-0.1-1.1-0.3-1.8-0.4-2.6c-0.1-0.4-0.1-0.5-0.1-0.7c0-0.2-0.2-0.3-0.4-0.3h-0.1l-2.6,0.4c-0.2,0-0.3,0.2-0.3,0.4c0,0,0,0,0,0.1l0.1,0.7c0.1,0.7,0.3,1.6,0.4,2.7c0.1,1.1,0.2,2.3,0.2,3.4c0,2.2-0.2,3.8-0.7,4.8c-0.5,1-1.4,1.8-2.5,2c-1.5,0.3-3.1,0.5-4.6,0.4L19.6,26.8z"/></svg>';

// Styled to the Umbraco Cloud Portal design system (its colors_and_type.css
// tokens and component previews): the navy top bar, white-lilac page, 12px
// bordered boxes, the portal's table and tinted tags, Lato. Light only, as
// the portal is.
export function renderStatus(rows: StatusRow[], now: number, signedInAs?: string): string {
  const running = rows.filter((r) => r.running).length;
  const stuck = rows.filter((r) => tone(r.state) === "danger").length;
  const body = rows
    .map((r) => {
      const repo = `${r.owner}/${r.repo}`;
      const href = `https://github.com/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}/issues/${r.issue_number}`;
      const step = r.last_step
        ? `${escape(r.last_step)}<div class="sub">${escape(ago(r.last_step_at, now))}</div>`
        : `<span class="muted">—</span>`;
      return `<tr>
  <td><a href="${escape(href)}">#${r.issue_number}</a><div class="sub">${escape(repo)}</div></td>
  <td><span class="tag ${tone(r.state)}">${escape(r.state)}</span></td>
  <td>${r.routine ? escape(r.routine) : '<span class="muted">—</span>'}${r.running ? ' <span class="tag running"><span class="dot"></span>Running</span>' : ""}</td>
  <td class="num">${r.attempt || ""}</td>
  <td>${step}</td>
  <td class="num">${r.rework_count || ""}</td>
  <td class="muted">${escape(ago(r.updated_at, now))}</td>
</tr>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${REFRESH_SECONDS}">
<title>Orchestrator status</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lato:wght@400;700;900&display=swap">
<style>
:root {
  --ucp-color-header-surface: #1b264f; --ucp-color-background: #f7f8fc; --ucp-color-surface: #ffffff;
  --ucp-color-text: #030229; --ucp-color-text-alt: #707b81;
  --ucp-color-divider: #e9edf7; --ucp-color-row-divider: #f0f2f8; --ucp-palette-soft-blue: #cdd7ee;
  --ucp-color-interactive: #1b264f; --ucp-color-interactive-emphasis: #1e2e7a; --ucp-color-focus: #4f64ff;
  --ucp-palette-dawn-pink: #fae9e8; --ucp-palette-primary-pink: #f5c1bc;
  --ucp-color-positive: #25aa60; --ucp-color-warning: #fad634; --ucp-color-danger: #d22d56;
  --ucp-border-radius-small: 3px; --ucp-border-radius-large: 12px;
  --ucp-shadow-depth-1: 0 6px 5px -4px rgba(0, 0, 0, 0.05);
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--ucp-color-background); color: var(--ucp-color-text); font: 15px/1.6 Lato, "Helvetica Neue", Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; }
.top-bar { height: 62px; background: var(--ucp-color-header-surface); color: #fff; display: flex; align-items: center; gap: 12px; padding: 0 24px; }
.top-bar .product { font-size: 15px; font-weight: 700; }
.top-bar .product span { font-weight: 400; color: rgba(255, 255, 255, 0.7); }
.top-bar .user { margin-left: auto; font-size: 13px; color: rgba(255, 255, 255, 0.8); display: flex; align-items: center; gap: 12px; }
.top-bar .user a { color: #fff; font-weight: 700; padding: 6px 12px; border-radius: 6px; }
.top-bar .user a:hover { background: #2a3360; text-decoration: none; color: #fff; }
main { width: min(100%, 1600px); margin: 0 auto; padding: 36px 50px 50px; }
.section-title { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 18px; }
.eyebrow { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: var(--ucp-color-text-alt); margin-bottom: 4px; }
h1 { margin: 0; font-size: 30px; font-weight: 700; line-height: 1.25; letter-spacing: -.005em; }
.refresh { font-size: 12px; color: var(--ucp-color-text-alt); }
.stats { display: grid; grid-template-columns: repeat(3, minmax(0, 220px)); gap: 18px; margin-bottom: 24px; }
.box { background: var(--ucp-color-surface); border: 1px solid var(--ucp-color-divider); border-radius: var(--ucp-border-radius-large); box-shadow: var(--ucp-shadow-depth-1); }
.stat { padding: 18px 20px; }
.stat-title { font-size: 13px; font-weight: 700; color: var(--ucp-color-interactive); }
.stat-value { font-size: 28px; font-weight: 900; color: var(--ucp-color-interactive); letter-spacing: -.01em; line-height: 1.2; margin-top: 6px; }
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
a { color: var(--ucp-color-interactive); font-weight: 700; text-decoration: none; transition: color .15s; }
a:hover { color: var(--ucp-color-interactive-emphasis); text-decoration: underline; }
a:focus-visible { outline: 2px solid var(--ucp-color-focus); outline-offset: 2px; border-radius: var(--ucp-border-radius-small); }
.sub { font-size: 12px; color: var(--ucp-color-text-alt); }
.muted { color: var(--ucp-color-text-alt); }
.tag { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; letter-spacing: .01em; padding: 3px 8px; border-radius: var(--ucp-border-radius-small); border: 1px solid transparent; white-space: nowrap; }
.tag .dot { width: 6px; height: 6px; border-radius: 50%; }
.tag.default { background: var(--ucp-color-background); color: var(--ucp-color-interactive); border-color: var(--ucp-palette-soft-blue); }
.tag.positive { background: #e3f6ec; color: #1e8a50; }
.tag.warning { background: #fef5d6; color: #8a7516; }
.tag.danger { background: #fbe4eb; color: #a82547; }
.tag.running { background: var(--ucp-color-positive); color: #fff; margin-left: 6px; }
.tag.running .dot { background: #fff; }
.empty { padding: 36px 22px; text-align: center; color: var(--ucp-color-text-alt); }
@media (max-width: 700px) {
  main { padding: 24px 16px 36px; }
  .top-bar { padding: 0 16px; }
  .stats { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 9px; }
  .stat { padding: 12px; }
  th, td { padding: 10px 14px; }
}
</style>
</head>
<body>
<header class="top-bar">${LOGO_MARK}<div class="product">Agent orchestrator <span>/ Live status</span></div>${
    signedInAs ? `<div class="user">${escape(signedInAs)}<a href="/auth/logout">Sign out</a></div>` : ""
  }</header>
<main>
<div class="section-title">
  <div><div class="eyebrow">Orchestrator · Live status</div><h1>Open issues</h1></div>
  <div class="refresh">Refreshes every ${REFRESH_SECONDS} seconds</div>
</div>
<div class="stats">
  <div class="box stat"><div class="stat-title">Tracked</div><div class="stat-value">${rows.length}</div></div>
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
</main>
</body>
</html>`;
}
