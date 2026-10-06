// The dashboard (03-components.md §3.6) as a Hono app: its routes, the
// sign-in check in front of them, and GitHub sign-in itself. Off unless
// STATUS_SECRET is set. People sign in with GitHub (auth.ts: a verified
// Umbraco email); scripts send `Authorization: Bearer <STATUS_SECRET>`.
//
// - GET /status: every issue and PR with a log, filtered by pills, with the
//   selected one's log (?open=owner/repo/N); ?format=json: issue_status rows
// - GET /status/repo?repo=o/r: a repo's controls and its activity
// - POST /status/controls: switches a control (same origin only)
// - GET /status/issue: the old log page, now a redirect into the list
// - /auth/login, /auth/callback, /auth/logout, /auth/signed-out
//
// Server-rendered, no script: every filter and selection is in the URL.

import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { handleCallback, handleLogin, handleLogout, readSession, signInConfigured, signedOut } from "../auth";
import { CONTROLS, controlsFor, isControl, reposWithControlOff, setControl } from "../controls";
import * as issueStatus from "../db/issue-status";
import * as itemsDb from "../db/items";
import * as logEntries from "../db/log-entries";
import type { LogEntry } from "../db/log-entries";
import * as transitions from "../db/transitions";
import { githubConfigured, type GitHubEnv } from "../github-client";
import { BACKFILL_MAX, backfillItems } from "../items";
import {
  MAX_ITEMS,
  attachedRepos,
  buildItems,
  listHref,
  orderRepos,
  pickRepo,
  readFilters,
  sandboxRepos,
  visible,
  type DashboardEnv,
  type Item,
} from "./model";
import { ListPage } from "./views/list";
import { MessagePage, RepoPage } from "./views/repo";
import { htmlResponse } from "./views/respond";

type Vars = {
  who: string; // the signed-in login, or "script" for the Bearer key
  user?: string; // the signed-in login, shown in the top bar
  script: boolean;
  repos: string[]; // attached, real ones first
  sandbox: string[];
};

export const dashboard = new Hono<{ Bindings: DashboardEnv; Variables: Vars }>();

/** Work to finish after the response (looking titles up on GitHub). */
function defer(c: Context, work: Promise<unknown>): void {
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    // No execution context (a test calling the app directly): let it run.
    work.catch(() => {});
  }
}

// --- who's asking ---------------------------------------------------------------

/** Signed in (a session from GitHub sign-in) or the Bearer key; else off
 * to sign in (a GET) or refused. Sets who's asking, and the repos. */
const gate = createMiddleware<{ Bindings: DashboardEnv; Variables: Vars }>(async (c, next) => {
  const env = c.env;
  if (!env.STATUS_SECRET) return c.text("not found", 404);
  const script = c.req.header("Authorization") === `Bearer ${env.STATUS_SECRET}`;
  const session = script ? null : await readSession(c.req.raw, env);
  if (!script && !session) {
    if (!signInConfigured(env) || c.req.method !== "GET") return c.text("unauthorized", 401);
    const url = new URL(c.req.url);
    const login = new URL("/auth/login", url);
    login.searchParams.set("next", url.pathname + url.search);
    return c.body(null, 302, { Location: login.pathname + login.search, "Cache-Control": "no-store" });
  }
  const sandbox = sandboxRepos(env);
  c.set("who", session?.login ?? "script");
  c.set("user", session?.login);
  c.set("script", script);
  c.set("sandbox", sandbox);
  c.set("repos", orderRepos(attachedRepos(env), sandbox));
  await next();
});

dashboard.use("/status", gate);
dashboard.use("/status/*", gate);

// --- the list -------------------------------------------------------------------

dashboard.get("/status", async (c) => {
  const env = c.env;
  const url = new URL(c.req.url);
  if (url.searchParams.get("format") === "json") {
    return c.json({ rows: await issueStatus.list(env.DB) }, 200, { "Cache-Control": "no-store" });
  }
  const repos = c.get("repos");
  const filters = readFilters(url, repos);
  // One row per item from its summary (db/items), never the whole log: a
  // load reads about as many rows as there are items.
  const [summary, status] = await Promise.all([itemsDb.listSummaries(env.DB, MAX_ITEMS), issueStatus.list(env.DB)]);
  const activity = summary.map((r) => ({ owner: r.owner, repo: r.repo, issue_number: r.issue_number, event: r.last_event, last_at: r.last_at, events: r.events, pr_hint: r.pr_hint, decisions: r.decisions, builds: r.builds }));
  const all = buildItems(activity, status, summary, repos);

  // Find with exactly one match: open its log straight away.
  if (filters.n && !filters.open) {
    const hits = visible(all, filters);
    if (hits.length === 1) filters.open = { repo: hits[0]!.repo, n: hits[0]!.n };
  }

  // Items whose webhooks all came before the items table: look up the open
  // one first, then the rest on this page, on GitHub after responding, so
  // the next refresh shows them.
  if (githubConfigured(env as GitHubEnv)) {
    const isOpenOne = (i: Item) => !!filters.open && i.repo === filters.open.repo && i.n === filters.open.n;
    const page = visible(all, filters).slice(0, filters.limit);
    const missing = [...all.filter(isOpenOne), ...page.filter((i) => !isOpenOne(i))].filter((i) => !i.known).slice(0, BACKFILL_MAX);
    if (missing.length > 0) defer(c, backfillItems(env as GitHubEnv & { DB: D1Database }, missing));
  }

  // Repos whose sweep is switched off are flagged on their pill.
  const sweepOff = await reposWithControlOff(env.DB, "sweep").catch(() => new Set<string>());

  let selected: { item: Item | null; log: transitions.LogRow[]; workLog: LogEntry[] } | null = null;
  if (filters.open) {
    // Only an opened item reads its logs: one indexed read each.
    const [owner, repo] = filters.open.repo.split("/") as [string, string];
    const [log, workLog] = await Promise.all([
      transitions.forIssue(env.DB, owner, repo, filters.open.n, { newestFirst: true, limit: 300 }),
      logEntries.forItems(env.DB, owner, repo, [filters.open.n]).catch(() => []),
    ]);
    selected = { item: all.find((i) => i.repo === filters.open!.repo && i.n === filters.open!.n) ?? null, log, workLog };
  }
  return htmlResponse(
    <ListPage items={all} filters={filters} repos={repos} sandbox={c.get("sandbox")} sweepOff={[...sweepOff]} selected={selected} now={Date.now()} user={c.get("user")} />,
  );
});

// The old separate log page: now the list's panel.
dashboard.get("/status/issue", (c) => {
  const repos = c.get("repos");
  const repo = pickRepo(repos, c.req.query("repo") ?? null);
  const n = Number(c.req.query("n"));
  const to = repo && Number.isInteger(n) && n > 0 ? listHref(readFilters(new URL("https://x/"), repos), { open: { repo, n } }) : "/status";
  return c.redirect(to, 301);
});

// --- a repository's controls ------------------------------------------------------

dashboard.get("/status/repo", async (c) => {
  const env = c.env;
  const full = pickRepo(c.get("repos"), c.req.query("repo") ?? null);
  if (!full) {
    return htmlResponse(
      <MessagePage title="Repository" user={c.get("user")} message="That isn't an attached repository." action={{ href: "/status", label: "Back to the list" }} />,
      404,
    );
  }
  const [owner, repo] = full.split("/") as [string, string];
  const [controls, activity] = await Promise.all([controlsFor(env.DB, owner, repo), transitions.forRepo(env.DB, owner, repo)]);
  const enforced = env.SWEEP_MODE === "enforce" || (env.SWEEP_ENFORCE_REPOS ?? "").split(",").map((r) => r.trim().toLowerCase()).includes(full);
  const saved = /^([a-z]+)-(on|off)$/.exec(c.req.query("saved") ?? "");
  const savedText = saved && isControl(saved[1]!) ? `${CONTROLS[saved[1]!].name} is now ${saved[2]}.` : null;
  return htmlResponse(<RepoPage repo={full} controls={controls} sweepEnforced={enforced} now={Date.now()} user={c.get("user")} saved={savedText} activity={activity} />);
});

dashboard.post("/status/controls", async (c) => {
  const url = new URL(c.req.url);
  // A person's form must come from this page: a cross-site form post would
  // carry their session cookie (SameSite=Lax doesn't stop top-level POSTs
  // in every browser), but never this origin.
  if (!c.get("script") && c.req.header("Origin") !== url.origin) return c.text("forbidden", 403);
  const form = await c.req.formData().catch(() => null);
  const full = pickRepo(c.get("repos"), String(form?.get("repo") ?? ""));
  const control = String(form?.get("control") ?? "");
  const enabled = String(form?.get("enabled") ?? "");
  if (!full || !isControl(control) || (enabled !== "0" && enabled !== "1")) return c.text("bad request", 400);
  const [owner, repo] = full.split("/") as [string, string];
  await setControl(c.env.DB, owner, repo, control, enabled === "1", c.get("who"));
  const back = new URLSearchParams({ repo: full, saved: `${control}-${enabled === "1" ? "on" : "off"}` });
  return c.body(null, 303, { Location: `/status/repo?${back}`, "Cache-Control": "no-store" });
});

dashboard.all("/status/*", (c) => c.text("not found", 404));

// --- sign-in ----------------------------------------------------------------------

dashboard.get("/auth/login", (c) => handleLogin(c.env, new URL(c.req.url)));
dashboard.get("/auth/callback", (c) => handleCallback(c.req.raw, c.env, new URL(c.req.url)));
dashboard.get("/auth/logout", () => handleLogout());
dashboard.get("/auth/signed-out", () => signedOut());
