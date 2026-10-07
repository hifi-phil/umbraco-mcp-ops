// /status: every issue and PR the Worker has a log for, filtered by pills,
// with the selected one's log beside the list (under its row on a narrow
// screen). Every link carries the filters, so a view is a URL.

import type { LogRow } from "../../db/transitions";
import type { LogEntry } from "../../db/log-entries";
import {
  MAX_SHOWN,
  PAGE,
  REFRESH_SECONDS,
  actorLabel,
  ago,
  clock,
  effectText,
  githubHref,
  isOpen,
  listHref,
  matches,
  needsAttention,
  rowId,
  tone,
  visible,
  when,
  type Filters,
  type Item,
} from "../model";
import { Layout } from "./layout";

export type ListPageProps = {
  items: Item[];
  filters: Filters;
  repos: string[];
  sandbox?: string[];
  sweepOff?: string[];
  selected: { item: Item | null; log: LogRow[]; workLog: LogEntry[] } | null;
  now: number;
  user?: string;
};

const E2e = () => <span class="e2e">e2e</span>;

const Running = () => (
  <span class="tag running">
    <span class="dot" />
    Running
  </span>
);

function StateTag({ item }: { item: Item }) {
  if (item.status) return <span class={`tag ${tone(item.status.state)}`}>{item.status.state}</span>;
  if (item.merged) return <span class="tag positive">merged</span>;
  if (item.closed) return <span class="tag quiet">closed</span>;
  return <span class="tag quiet">not tracked</span>;
}

const KindTag = ({ item }: { item: Item }) => <span class="kind">{item.kind === "pr" ? "PR" : "Issue"}</span>;

function Title({ item }: { item: Item }) {
  if (item.title) return <>{item.title}</>;
  return <span class="muted">{item.title === "" ? "Not on GitHub any more" : "Title on its way"}</span>;
}

function Pill({ label, count, href, current, children }: { label: string; count: number; href: string; current: boolean; children?: unknown }) {
  return (
    <a class="pill" href={href} aria-current={current ? "true" : undefined}>
      {label}
      {children} <span class="count">{count}</span>
    </a>
  );
}

function By({ actor }: { actor?: string | null }) {
  const by = actorLabel(actor);
  if (!by) return null;
  return <> · by {by.person ? <span class="person">{by.text}</span> : by.text}</>;
}

/** The decision log and build log (16-work-log.md), oldest first: what the
 * routines decided and checked, beside what the labels did. */
function WorkLog({ entries, now }: { entries: LogEntry[]; now: number }) {
  return (
    <>
      <div class="panel-log-title">
        Work log <span class="muted">({entries.length}, oldest first)</span>
      </div>
      <div class="wrap">
        <table class="log work-log">
          <thead>
            <tr>
              <th>When</th>
              <th>Entry</th>
              <th>Routine</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 ? (
              <tr>
                <td colspan={3} class="empty">
                  Nothing in the work log yet.
                </td>
              </tr>
            ) : (
              entries.map((e) => (
                <tr>
                  <td>
                    {when(e.created_at)}
                    <div class="sub">{ago(e.created_at, now)}</div>
                  </td>
                  <td>
                    <span class={`tag ${e.kind === "decision" ? "default" : "quiet"}`}>
                      {e.kind}
                      {e.category ? ` · ${e.category}` : ""}
                    </span>{" "}
                    <span class="muted">#{e.id}</span>
                    {e.refs.length > 0 && <span class="sub"> from journal {e.refs.map((r) => `#${r}`).join(", ")}</span>}
                    <pre class="entry">{e.body}</pre>
                  </td>
                  <td>{e.routine}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function Panel({
  item,
  open,
  log,
  workLog = [],
  now,
  filters: f,
}: {
  item: Item | null;
  open: { repo: string; n: number };
  log: LogRow[];
  workLog?: LogEntry[];
  now: number;
  filters: Filters;
}) {
  const s = item?.status ?? null;
  return (
    <div class="box panel">
      <div class="panel-head">
        <div>
          <div class="eyebrow">
            {open.repo} · {item && <KindTag item={item} />}
          </div>
          <h2>
            #{open.n}
            {item?.title ? ` ${item.title}` : ""}
          </h2>
        </div>
        <div class="panel-actions">
          <a class="button secondary" href={githubHref(open.repo, open.n)}>
            GitHub
          </a>
          <a class="button secondary" href={`${listHref(f, { open: null, n: null })}#${rowId(open)}`} aria-label="Close the log">
            Close
          </a>
        </div>
      </div>
      <div class="panel-facts">
        {s ? (
          <div class="facts">
            <div>
              <div class="label">State</div>
              <StateTag item={item!} />
            </div>
            <div>
              <div class="label">Routine</div>
              {s.routine ?? "—"}
              {s.running ? <> <Running /></> : null}
            </div>
            <div>
              <div class="label">Attempt</div>
              {s.attempt || "—"}
            </div>
            <div>
              <div class="label">Last step</div>
              {s.last_step ? (
                <>
                  {s.last_step} <span class="sub">{ago(s.last_step_at, now)}</span>
                </>
              ) : (
                "—"
              )}
            </div>
            <div>
              <div class="label">Reworks</div>
              {s.rework_count || "—"}
            </div>
          </div>
        ) : (
          <div class="facts">
            <div>
              <div class="label">State</div>
              {item ? <StateTag item={item} /> : <span class="tag quiet">not tracked</span>}
            </div>
          </div>
        )}
      </div>
      <WorkLog entries={workLog} now={now} />
      <div class="panel-log-title">
        Transitions{" "}
        <span class="muted">
          ({log.length}
          {log.length === 300 ? ", newest 300" : ""}, newest first)
        </span>
      </div>
      <div class="wrap">
        <table class="log">
          <thead>
            <tr>
              <th>When</th>
              <th>Event</th>
              <th>Effect</th>
              <th>Routine</th>
              <th>Mode</th>
            </tr>
          </thead>
          <tbody>
            {log.length === 0 ? (
              <tr>
                <td colspan={5} class="empty">
                  Nothing logged.
                </td>
              </tr>
            ) : (
              log.map((r) => (
                <tr>
                  <td>
                    {when(r.created_at)}
                    <div class="sub">{ago(r.created_at, now)}</div>
                  </td>
                  <td>
                    <code>{r.event}</code>
                    <div class="sub">
                      from {r.from_state}
                      <By actor={r.actor} />
                    </div>
                  </td>
                  <td>
                    {effectText(r.to_effect)}
                    {r.dropped_reason && <div class="sub">{r.dropped_reason}</div>}
                  </td>
                  <td>{r.run ?? <span class="muted">—</span>}</td>
                  <td>
                    <span class={`tag ${r.mode === "enforce" ? "default" : "quiet"}`}>{r.mode}</span>
                    <div class="sub">{r.delivery_id ? `delivery ${r.delivery_id.slice(0, 8)}` : "no delivery"}</div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const workLogCounts = (i: Item) =>
  [plural(i.decisions, "decision", "decisions"), plural(i.journals, "journal entry", "journal entries"), plural(i.builds, "build entry", "build entries")].join(", ");

function Row({ item: i, f, selected, sandbox, now, panel }: { item: Item; f: Filters; selected: boolean; sandbox: boolean; now: number; panel: unknown }) {
  // The link lands back on this row (#id), so the list keeps its place.
  // Closing also drops a Find, which would open its one match again.
  const href = `${listHref(f, selected ? { open: null, n: null } : { open: { repo: i.repo, n: i.n } })}#${rowId(i)}`;
  return (
    <>
      <a class={selected ? "row selected" : "row"} id={rowId(i)} href={href} aria-current={selected ? "true" : undefined} title={selected ? "Close its log" : undefined}>
        <span class="row-main">
          <span class="num">#{i.n}</span> <KindTag item={i} />{" "}
          <span class="title">
            <Title item={i} />
          </span>
        </span>
        <span class="row-meta">
          <StateTag item={i} />
          {i.status?.running ? <> <Running /></> : null}
          {i.status?.routine && (
            <>
              {" "}
              <span class="routine">
                {i.status.routine}
                {i.status.attempt > 1 && <span class="muted"> · try {i.status.attempt}</span>}
              </span>
            </>
          )}
        </span>
        <span class="row-sub">
          {i.repo}
          {sandbox && <> <E2e /></>} · <code>{i.lastEvent}</code> · {ago(i.lastAt, now)}
          {i.journals + i.decisions + i.builds > 0 && (
            <>
              {" "}
              · <span class="work-log-count">{workLogCounts(i)}</span>
            </>
          )}
        </span>
      </a>
      {/* On a narrow screen the log opens under its row instead of beside the list. */}
      {selected && <div class="inline-log">{panel}</div>}
    </>
  );
}

export function ListPage(p: ListPageProps) {
  const { items, filters: f, repos, selected, now, user } = p;
  const sandbox = p.sandbox ?? [];
  const sweepOff = p.sweepOff ?? [];
  const shown = visible(items, f);
  const byType = items.filter((i) => matches(i, f, "type"));
  const byStatus = items.filter((i) => matches(i, f, "status"));
  const inRepo = (r: string | null) => items.filter((i) => matches(i, { ...f, repo: r })).length;
  const panel = selected ? (
    <Panel item={selected.item} open={f.open!} log={selected.log} workLog={selected.workLog} now={now} filters={f} />
  ) : (
    <div class="box pad panel-empty">
      <p class="lead">Pick an issue or pull request to see its log.</p>
    </div>
  );
  const page = shown.slice(0, f.limit);

  return (
    <Layout title="Orchestrator status" user={user} refresh>
      <div class="section-title">
        <div>
          <div class="eyebrow">Orchestrator · Live status</div>
          <h1>Issues and pull requests</h1>
        </div>
        <div class="refresh">
          Updated {clock(now)} · <a href={listHref(f)}>Refresh</a> · every {REFRESH_SECONDS / 60} minutes
          {f.repo && (
            <>
              {" · "}
              <a href={`/status/repo?repo=${encodeURIComponent(f.repo)}`}>{f.repo} settings</a>
            </>
          )}
        </div>
      </div>
      <div class="filters">
        <div class="pills" role="group" aria-label="Type">
          <Pill label="All types" count={byType.length} href={listHref(f, { type: "all", open: null })} current={f.type === "all"} />
          <Pill label="Issues" count={byType.filter((i) => i.kind === "issue").length} href={listHref(f, { type: "issue", open: null })} current={f.type === "issue"} />
          <Pill label="Pull requests" count={byType.filter((i) => i.kind === "pr").length} href={listHref(f, { type: "pr", open: null })} current={f.type === "pr"} />
        </div>
        <div class="pills" role="group" aria-label="Status">
          <Pill label="Any status" count={byStatus.length} href={listHref(f, { status: "all", open: null })} current={f.status === "all"} />
          <Pill label="Open" count={byStatus.filter(isOpen).length} href={listHref(f, { status: "open", open: null })} current={f.status === "open"} />
          <Pill label="Running" count={byStatus.filter((i) => i.status?.running).length} href={listHref(f, { status: "running", open: null })} current={f.status === "running"} />
          <Pill label="Needs attention" count={byStatus.filter(needsAttention).length} href={listHref(f, { status: "attention", open: null })} current={f.status === "attention"} />
          <Pill label="Closed" count={byStatus.filter((i) => i.closed).length} href={listHref(f, { status: "closed", open: null })} current={f.status === "closed"} />
        </div>
        <div class="pills" role="group" aria-label="Repository">
          <Pill label="All repositories" count={inRepo(null)} href={listHref(f, { repo: null, open: null })} current={!f.repo} />
          {repos.map((r) => (
            <Pill label={r} count={inRepo(r)} href={listHref(f, { repo: r, open: null })} current={f.repo === r}>
              {sandbox.includes(r) && <> <E2e /></>}
              {sweepOff.includes(r) && (
                <>
                  {" "}
                  <span class="paused" title="Its reconciliation sweep is switched off">
                    sweep off
                  </span>
                </>
              )}
            </Pill>
          ))}
        </div>
        <form class="lookup" method="get" action="/status">
          {f.repo && <input type="hidden" name="repo" value={f.repo} />}
          {f.type !== "all" && <input type="hidden" name="type" value={f.type} />}
          {f.status !== "all" && <input type="hidden" name="status" value={f.status} />}
          <label class="sr" for="find-n">
            Issue or pull request number
          </label>
          <input id="find-n" name="n" type="number" min="1" inputmode="numeric" placeholder="Find a number" value={f.n ? String(f.n) : ""} />
          <button type="submit" class="secondary">
            Find
          </button>
          {f.n && (
            <>
              {" "}
              <a class="quiet" href={listHref(f, { n: null, open: null })}>
                Clear
              </a>
            </>
          )}
        </form>
      </div>
      <div class={selected ? "split has-selection" : "split"}>
        <div class="box list" aria-label="Issues and pull requests">
          {shown.length > 0 && <div class="list-head">Showing {shown.length > f.limit ? `1–${f.limit} of ${shown.length}` : `all ${shown.length}`}</div>}
          {page.length === 0 ? (
            <div class="empty">Nothing matches these filters.</div>
          ) : (
            page.map((i) => (
              <Row item={i} f={f} selected={!!f.open && f.open.repo === i.repo && f.open.n === i.n} sandbox={sandbox.includes(i.repo)} now={now} panel={panel} />
            ))
          )}
          {shown.length > f.limit && (
            <a class="more" href={`${listHref(f, { limit: Math.min(f.limit + PAGE, MAX_SHOWN) })}#${rowId(shown[f.limit]!)}`}>
              Show {Math.min(PAGE, shown.length - f.limit)} more of {shown.length - f.limit}
            </a>
          )}
        </div>
        <div class="detail">{panel}</div>
      </div>
    </Layout>
  );
}
