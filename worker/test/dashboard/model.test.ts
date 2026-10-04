// The dashboard's model: pure functions, no I/O.
import { describe, expect, it } from "vitest";
import {
  actorLabel,
  ago,
  attachedRepos,
  buildItems,
  effectText,
  listHref,
  readFilters,
  visible,
  when,
  type ActivityRow,
  type Filters,
  type ItemRow,
} from "../../src/dashboard/model";
import type { StatusRow } from "../../src/db/issue-status";

const OPS = "hifi-phil/umbraco-mcp-ops";
const SANDBOX = "hifi-phil/mcp-ops-e2e-testing";
const REPOS = [SANDBOX, OPS];
const NO_FILTERS: Filters = { repo: null, type: "all", status: "all", n: null, open: null, limit: 100 };

const status = (o: Partial<StatusRow> = {}): StatusRow => ({
  owner: "hifi-phil",
  repo: "umbraco-mcp-ops",
  issue_number: 412,
  state: "ai-ready",
  routine: "issue-build-loop",
  attempt: 1,
  running: 1,
  last_step: null,
  last_step_at: null,
  rework_count: 0,
  updated_at: "2026-10-03 10:00:00",
  ...o,
});
const activity = (o: Partial<ActivityRow> = {}): ActivityRow => ({
  owner: "hifi-phil",
  repo: "umbraco-mcp-ops",
  issue_number: 412,
  event: "labelled_ai_ready",
  last_at: "2026-10-03 10:00:00",
  events: 1,
  pr_hint: 0,
  ...o,
});
const meta = (o: Partial<ItemRow> = {}): ItemRow => ({ owner: "hifi-phil", repo: "umbraco-mcp-ops", issue_number: 412, kind: "issue", title: "Add a thing", gh_state: "open", ...o });

describe("attachedRepos", () => {
  it("REPO_ROUTINES_JSON's keys, lowercased and sorted (never its values: they hold fire tokens)", () => {
    const json = JSON.stringify({ "Hifi-Phil/umbraco-mcp-ops": { token: "secret" }, [SANDBOX]: {} });
    expect(attachedRepos({ DB: {} as D1Database, REPO_ROUTINES_JSON: json })).toEqual(REPOS);
    expect(attachedRepos({ DB: {} as D1Database, REPO_ROUTINES_JSON: "not json" })).toEqual([]);
  });
});

describe("buildItems", () => {
  it("joins the live status and the item's kind and title", () => {
    expect(buildItems([activity()], [status()], [meta()], REPOS)[0]).toMatchObject({ repo: OPS, n: 412, kind: "issue", title: "Add a thing", closed: false, status: { state: "ai-ready" } });
  });

  it("not known yet: a PR-only event makes it a PR, a closing last event closed; otherwise an issue", () => {
    expect(buildItems([activity({ event: "merged", pr_hint: 1 })], [], [], REPOS)[0]).toMatchObject({ kind: "pr", closed: true, merged: true, known: false });
    expect(buildItems([activity({ event: "build_blocked" })], [], [], REPOS)[0]).toMatchObject({ kind: "issue", closed: false, known: false });
  });

  it("GitHub's state wins: a closed item shows no stale live status; open on GitHub counts as open", () => {
    expect(buildItems([activity()], [status()], [meta({ gh_state: "closed" })], REPOS)[0]).toMatchObject({ closed: true, status: null });
    expect(buildItems([activity()], [], [meta({ gh_state: "open" })], REPOS)[0]).toMatchObject({ ghOpen: true });
  });

  it("drops a repo that isn't attached; matches case-insensitively", () => {
    expect(buildItems([activity({ owner: "evil", repo: "repo" })], [], [], REPOS)).toEqual([]);
    expect(buildItems([activity({ owner: "Hifi-Phil" })], [], [], REPOS)).toHaveLength(1);
  });
});

describe("visible: running, then needing attention, then open, then by latest activity", () => {
  it("orders and filters", () => {
    const items = buildItems(
      [
        activity({ issue_number: 1, last_at: "2026-10-03 10:05:00" }),
        activity({ issue_number: 3, event: "watchdog_expired", last_at: "2026-10-03 10:07:00" }),
        activity({ issue_number: 4, event: "merged", pr_hint: 1, last_at: "2026-10-03 10:08:00" }),
        activity({ issue_number: 5, last_at: "2026-10-03 10:09:00" }),
      ],
      [status({ issue_number: 1, running: 1 }), status({ issue_number: 3, state: "ai-stuck", running: 0 })],
      [],
      REPOS,
    );
    expect(visible(items, NO_FILTERS).map((i) => i.n)).toEqual([1, 3, 5, 4]);
    expect(visible(items, { ...NO_FILTERS, type: "pr" }).map((i) => i.n)).toEqual([4]);
    expect(visible(items, { ...NO_FILTERS, status: "attention" }).map((i) => i.n)).toEqual([3]);
  });
});

describe("filters in the URL", () => {
  it("reads them, dropping anything unknown to its default", () => {
    const f = readFilters(new URL(`https://w/status?type=pr&status=attention&repo=${encodeURIComponent(OPS.toUpperCase())}&n=7&open=${OPS}/7&limit=300`), REPOS);
    expect(f).toEqual({ repo: OPS, type: "pr", status: "attention", n: 7, open: { repo: OPS, n: 7 }, limit: 300 });
    expect(readFilters(new URL("https://w/status?type=x&status=y&repo=evil/repo&n=-1&open=evil/repo/3"), REPOS)).toEqual(NO_FILTERS);
    expect(readFilters(new URL("https://w/status?limit=99999"), REPOS).limit).toBe(1000);
  });

  it("writes them back with the defaults left out", () => {
    expect(listHref(NO_FILTERS)).toBe("/status");
    expect(listHref(NO_FILTERS, { type: "pr", open: { repo: OPS, n: 9 } })).toBe(`/status?type=pr&open=${encodeURIComponent(`${OPS}/9`)}`);
  });
});

describe("formatting", () => {
  it("effects in words", () => {
    expect(effectText('{"kind":"label","value":"ai-stuck"}')).toBe("→ ai-stuck");
    expect(effectText('{"kind":"close"}')).toBe("closed");
    expect(effectText('{"kind":"unlabel"}')).toBe("label removed");
    expect(effectText('{"kind":"noop"}')).toBe("no change");
    expect(effectText('{"kind":"noop","held":"mode_shadow"}')).toBe("nothing (held: mode_shadow)");
    expect(effectText('{"kind":"manual","change":"-ai-blocked"}')).toBe("by hand: -ai-blocked");
    expect(effectText('{"control":"sweep","enabled":false,"by":"octo"}')).toBe("sweep turned off by octo");
    expect(effectText(null)).toBe("");
    expect(effectText("not json")).toBe("not json");
  });

  it("times: DD-MM-YYYY HH:MM:SS UTC, and how long ago", () => {
    expect(when("2026-10-03 09:05:07")).toBe("03-10-2026 09:05:07 UTC");
    const now = Date.parse("2026-10-02T12:00:00Z");
    expect(ago("2026-10-02 11:59:40", now)).toBe("just now");
    expect(ago("2026-10-02T11:30:00.000Z", now)).toBe("30 min ago");
    expect(ago("2026-10-02 09:00:00", now)).toBe("3 h ago");
    expect(ago("2026-09-28 12:00:00", now)).toBe("4 d ago");
  });

  it("who caused a row: the Worker's own, a bot, or a person (marked)", () => {
    expect(actorLabel("watchdog")).toEqual({ text: "the watchdog", person: false });
    expect(actorLabel("umbraco-agent-orchestrator[bot]")).toEqual({ text: "umbraco-agent-orchestrator[bot]", person: false });
    expect(actorLabel("hifi-phil")).toEqual({ text: "hifi-phil", person: true });
    expect(actorLabel(null)).toBeNull();
  });
});
