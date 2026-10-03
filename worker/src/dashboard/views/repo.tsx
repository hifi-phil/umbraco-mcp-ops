// /status/repo: a repo's controls (each with who last changed it, and a
// form to switch it) and its repository-level activity.

import { CONTROLS, type Control } from "../../controls";
import type { LogRow } from "../../db/transitions";
import { ago, effectText, when } from "../model";
import { Layout } from "./layout";

export type RepoControl = { control: Control; enabled: boolean; row: { updated_by: string; updated_at: string } | null };

export function RepoPage({
  repo: full,
  controls,
  sweepEnforced,
  now,
  user,
  saved,
  activity,
}: {
  repo: string;
  controls: RepoControl[];
  sweepEnforced: boolean;
  now: number;
  user?: string;
  saved: string | null;
  activity: LogRow[];
}) {
  const here = `/status?repo=${encodeURIComponent(full)}`;
  return (
    <Layout title={`${full} · Orchestrator`} user={user}>
      <div class="crumbs">
        <a href="/status">Issues and pull requests</a> / <a href={here}>{full}</a> / Settings
      </div>
      <div class="section-title">
        <div>
          <div class="eyebrow">Repository settings</div>
          <h1>{full}</h1>
        </div>
        <a class="button secondary" href={here}>
          View its issues and PRs
        </a>
      </div>
      {saved && (
        <div class="banner" role="status">
          {saved} The change is logged under repository activity.
        </div>
      )}
      <div class="box">
        {controls.map(({ control, enabled, row }) => (
          <div class="control">
            <div class="control-text">
              <div class="control-name">
                {CONTROLS[control].name} <span class={`tag ${enabled ? "positive" : "quiet"}`}>{enabled ? "On" : "Off"}</span>
              </div>
              <p>{CONTROLS[control].about}</p>
              {control === "sweep" && (
                <div class="sub">When on, it {sweepEnforced ? "re-fires (enforce)" : "only logs what it would re-fire (shadow)"} for this repository.</div>
              )}
              <div class="sub">{row ? `Changed by ${row.updated_by}, ${ago(row.updated_at, now)}` : "Default: never changed"}</div>
            </div>
            <form method="post" action="/status/controls">
              <input type="hidden" name="repo" value={full} />
              <input type="hidden" name="control" value={control} />
              <input type="hidden" name="enabled" value={enabled ? "0" : "1"} />
              <button type="submit" class={enabled ? "secondary" : ""}>
                {enabled ? "Turn off" : "Turn on"}
              </button>
            </form>
          </div>
        ))}
      </div>
      <p class="sub below-small">More controls arrive here as agents and routines get their own switches.</p>
      <h2>Repository activity</h2>
      <div class="box table-box">
        <div class="wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Event</th>
                <th>What</th>
              </tr>
            </thead>
            <tbody>
              {activity.length === 0 ? (
                <tr>
                  <td colspan={3} class="empty">
                    Nothing yet.
                  </td>
                </tr>
              ) : (
                activity.map((r) => (
                  <tr>
                    <td>
                      {when(r.created_at)}
                      <div class="sub">{ago(r.created_at, now)}</div>
                    </td>
                    <td>
                      <code>{r.event}</code>
                    </td>
                    <td>{effectText(r.to_effect)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </Layout>
  );
}

/** A page with just a message (not an attached repo, sign-in outcomes). */
export function MessagePage({ title, message, action, user }: { title: string; message: string; action?: { href: string; label: string }; user?: string }) {
  return (
    <Layout title={title} user={user}>
      <div class="box pad message">
        <p class="lead">{message}</p>
        {action && (
          <a class="button" href={action.href}>
            {action.label}
          </a>
        )}
      </div>
    </Layout>
  );
}
