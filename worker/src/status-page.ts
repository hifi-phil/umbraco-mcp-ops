// GET /status: the live-status dashboard (03-components.md §3.6). A thin,
// read-only render of the issue_status table (migrations/0004), reloading
// itself every REFRESH_SECONDS, no push. Off unless STATUS_SECRET is set; the browser's
// own Basic auth prompt asks for it (any user name), and a Bearer header
// works too, for scripts. ?format=json returns the rows instead.

export type StatusEnv = { DB: D1Database; STATUS_SECRET?: string };

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

function authorized(request: Request, secret: string): boolean {
  const header = request.headers.get("Authorization") ?? "";
  if (header === `Bearer ${secret}`) return true;
  if (!header.startsWith("Basic ")) return false;
  try {
    const decoded = atob(header.slice(6));
    return decoded.slice(decoded.indexOf(":") + 1) === secret;
  } catch {
    return false;
  }
}

export async function handleStatus(request: Request, env: StatusEnv, url: URL): Promise<Response> {
  if (!env.STATUS_SECRET) return new Response("not found", { status: 404 });
  if (!authorized(request, env.STATUS_SECRET)) {
    return new Response("unauthorized", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="orchestrator status"' } });
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
  return new Response(renderStatus(results, Date.now()), {
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

/** The Umbraco UI tag colour for a state: trouble, waiting on a person, or done. */
function tone(state: string): string {
  if (state === "ai-stuck" || state === "merge-blocked") return "danger";
  if (state === "ai-blocked") return "warning";
  if (state === "generated-by-ai") return "positive";
  return "default";
}

// Styled after the Umbraco Cloud portal, with Umbraco UI's own tokens
// (Umbraco.UI's uui-css: palette, colors, shadow, fonts): the space-cadet
// header bar, sand background, white boxes, Lato.
/** How often the page reloads itself (a meta refresh: no script needed). */
export const REFRESH_SECONDS = 30;

export function renderStatus(rows: StatusRow[], now: number): string {
  const running = rows.filter((r) => r.running).length;
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
  <td>${r.routine ? escape(r.routine) : '<span class="muted">—</span>'}${r.running ? ' <span class="tag positive solid">Running</span>' : ""}</td>
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
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lato:wght@400;700&display=swap">
<style>
:root {
  --header: #1b264f; --header-contrast: rgba(255, 255, 255, 0.8); --header-emphasis: #fff;
  --bg: #f3f3f5; --surface: #fff; --text: #060606; --text-alt: #68676b;
  --border: #d8d7d9; --divider: #e9e9eb; --interactive: #1b264f; --interactive-emphasis: #3544b1;
  --positive: #0b8152; --warning: #fbd142; --warning-standalone: #a17700; --danger: #c31d4c;
  --shadow: 0 1px 3px rgba(0, 0, 0, 0.12), 0 1px 2px rgba(0, 0, 0, 0.24);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --header: #14171b; --bg: #22272e; --surface: #2d333b; --text: #cdd9e5; --text-alt: #8b97a5;
    --border: #4d5661; --divider: #383d44; --interactive: #cdd9e5; --interactive-emphasis: #8fa0ff;
    --positive: #2fae7a; --warning-standalone: #ffd82c; --danger: #f0567f;
  }
}
:root[data-theme="dark"] {
  --header: #14171b; --bg: #22272e; --surface: #2d333b; --text: #cdd9e5; --text-alt: #8b97a5;
  --border: #4d5661; --divider: #383d44; --interactive: #cdd9e5; --interactive-emphasis: #8fa0ff;
  --positive: #2fae7a; --warning-standalone: #ffd82c; --danger: #f0567f;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 Lato, "Helvetica Neue", Helvetica, Arial, sans-serif; }
header { background: var(--header); color: var(--header-contrast); height: 60px; display: flex; align-items: center; gap: 12px; padding: 0 24px; }
header .logo { width: 28px; height: 28px; border-radius: 50%; border: 2px solid var(--header-emphasis); display: grid; place-items: center; color: var(--header-emphasis); font-weight: 700; font-size: 13px; }
header h1 { margin: 0; font-size: 16px; font-weight: 700; color: var(--header-emphasis); }
header .crumb { font-size: 14px; }
main { max-width: 1200px; margin: 0 auto; padding: 24px; }
.title { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 18px; }
.title h2 { margin: 0; font-size: 24px; font-weight: 700; }
.title p { margin: 0; color: var(--text-alt); }
.box { background: var(--surface); border-radius: 3px; box-shadow: var(--shadow); }
.box-head { padding: 12px 18px; border-bottom: 1px solid var(--divider); font-weight: 700; display: flex; gap: 18px; }
.box-head .stat { font-weight: 400; color: var(--text-alt); }
.box-head .stat b { color: var(--text); }
.wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; min-width: 760px; }
th, td { text-align: left; padding: 12px 18px; border-bottom: 1px solid var(--divider); vertical-align: top; }
th { font-weight: 700; font-size: 12px; color: var(--text-alt); }
tr:last-child td { border-bottom: 0; }
tbody tr:hover td { background: color-mix(in srgb, var(--interactive-emphasis) 4%, transparent); }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
a { color: var(--interactive); font-weight: 700; text-decoration: none; }
a:hover { color: var(--interactive-emphasis); text-decoration: underline; }
.sub { font-size: 12px; color: var(--text-alt); }
.muted { color: var(--text-alt); }
.tag { display: inline-block; border: 1px solid var(--border); border-radius: 12px; padding: 0 9px; font-size: 12px; line-height: 20px; white-space: nowrap; }
.tag.positive { color: var(--positive); border-color: var(--positive); }
.tag.warning { color: var(--warning-standalone); border-color: var(--warning-standalone); }
.tag.danger { color: var(--danger); border-color: var(--danger); }
.tag.solid.positive { background: var(--positive); color: #fff; margin-left: 6px; }
.empty { padding: 36px; text-align: center; color: var(--text-alt); }
@media (max-width: 600px) { header, main { padding-left: 16px; padding-right: 16px; } th, td { padding: 9px 12px; } }
</style>
</head>
<body>
<header><span class="logo" aria-hidden="true">AO</span><h1>Agent orchestrator</h1><span class="crumb">/ Status</span></header>
<main>
<div class="title"><h2>Open issues</h2><p>Refreshes every ${REFRESH_SECONDS} seconds.</p></div>
<div class="box">
<div class="box-head"><span class="stat"><b>${rows.length}</b> tracked</span><span class="stat"><b>${running}</b> running</span></div>
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
