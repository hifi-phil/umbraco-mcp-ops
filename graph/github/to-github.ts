// Turns a fired Rule's Effect into the concrete GitHub calls it requires.
// The mirror image of from-github.ts: that goes raw webhook -> abstract
// domain Event (GitHub telling us something happened); this goes abstract
// Rule -> raw GitHub label operations (us telling GitHub what to do about
// it). Genuinely a separate stage from ../graph.ts's reduce() — it takes a
// different input (currentLabels, a live read) and produces a different
// output (concrete ops), not just "the same table split across two files".

import type { Rule, State } from "../graph";

export type Effect =
  | { kind: "label"; value: State }
  | { kind: "unlabel" }
  | { kind: "close" } // native GitHub close, not a label — see auto-release-loop precedent
  | { kind: "noop" }; // no GitHub write at all — e.g. a soft merge-gate failure leaves the label exactly as-is

export function label(value: State): Effect {
  return { kind: "label", value };
}
export const unlabel: Effect = { kind: "unlabel" };
export const close: Effect = { kind: "close" };
export const noop: Effect = { kind: "noop" };

export type LabelOp =
  | { op: "add"; label: string }
  | { op: "remove"; label: string }
  | { op: "close" };

/**
 * The concrete GitHub calls a fired rule requires, given the labels actually
 * present right now — re-read fresh from the API per §3.4, never cached.
 * Diffing against the real current labels (not just assuming `rule.from`'s
 * label is still there) means a label a human already removed by hand isn't
 * redundantly removed again, and a label the *triggering* webhook itself
 * just added (e.g. a human labelling `ai-ready`) is never redundantly
 * re-added — it's already in `currentLabels` by the time this runs.
 *
 * No mapping table needed here: `rule.from`/`rule.to.value` already *are*
 * the real label strings (see ../constants/labels.ts).
 */
export function labelOps(currentLabels: readonly string[], rule: Rule): LabelOp[] {
  if (rule.to.kind === "noop") return [];
  if (rule.to.kind === "close") return [{ op: "close" }];

  const fromLabel = rule.from === "none" ? null : rule.from;
  const toLabel = rule.to.kind === "label" ? rule.to.value : null;
  const ops: LabelOp[] = [];

  if (fromLabel && fromLabel !== toLabel && currentLabels.includes(fromLabel)) {
    ops.push({ op: "remove", label: fromLabel });
  }
  if (toLabel && toLabel !== fromLabel && !currentLabels.includes(toLabel)) {
    ops.push({ op: "add", label: toLabel });
  }
  return ops;
}
