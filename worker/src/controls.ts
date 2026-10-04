// Per-repo controls (migrations/0005_repo_controls.sql): switches people flip
// from the dashboard, read by the Worker before it acts for a repo. No row
// means on. Today the reconciliation sweep; later, one per agent.

import * as controlsDb from "./db/controls";
import type { ControlRow } from "./db/controls";

/** Every control, with what the dashboard says about it. */
export const CONTROLS = {
  sweep: {
    name: "Reconciliation sweep",
    about: "Every 15 minutes, finds issues left in a trigger state with nothing watching them, and re-fires their routine (or, in shadow, only logs it).",
  },
} as const;

export type Control = keyof typeof CONTROLS;

export const isControl = (c: string): c is Control => Object.prototype.hasOwnProperty.call(CONTROLS, c);

export type { ControlRow } from "./db/controls";

/** The repos ("owner/repo", lowercased) where this control is switched off. */
export function reposWithControlOff(db: D1Database, control: Control): Promise<Set<string>> {
  return controlsDb.reposWithOff(db, control);
}

/** One repo's controls, each with its row if it was ever set (no row: on). */
export async function controlsFor(db: D1Database, owner: string, repo: string): Promise<{ control: Control; enabled: boolean; row: ControlRow | null }[]> {
  const rows = await controlsDb.forRepo(db, owner, repo);
  return (Object.keys(CONTROLS) as Control[]).map((control) => {
    const row = rows.find((r) => r.control === control) ?? null;
    return { control, enabled: row ? row.enabled === 1 : true, row };
  });
}

/** Switches a control, and logs the change. */
export function setControl(db: D1Database, owner: string, repo: string, control: Control, enabled: boolean, by: string): Promise<void> {
  return controlsDb.set(db, owner, repo, control, enabled, by);
}
