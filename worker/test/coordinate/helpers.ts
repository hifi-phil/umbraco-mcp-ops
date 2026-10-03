// Shared fakes for the coordinate/ tests: an in-memory Deps, a webhook
// input, and merge-gate facts.
import { vi } from "vitest";
import { watchdogMinutesFor, type CiFix, type CoordinateInput, type Deps, type PendingFire } from "../../src/coordinate";
import type { MergeGateFacts } from "../../../graph/github/merge-gate";

export function gateFacts(overrides: Partial<MergeGateFacts> = {}): MergeGateFacts {
  return {
    checkRuns: [{ status: "completed", conclusion: "success" }],
    latestReviewState: "approved",
    mergeable: true,
    ...overrides,
  };
}

export function fakeDeps(overrides: Partial<Deps> = {}): Deps {
  const seen = new Set<string>();
  let pendingFire: PendingFire | null = null;
  let ciFix: CiFix | null = null;
  let reconcileReported: string | null = null;
  let completed: string | null = null;
  return {
    getLabels: vi.fn(async () => []),
    addLabel: vi.fn(async () => {}),
    removeLabel: vi.fn(async () => {}),
    closeIssue: vi.fn(async () => {}),
    commentOnIssue: vi.fn(async () => {}),
    fireRoutine: vi.fn(async () => {}),
    logTransition: vi.fn(async () => {}),
    hasSeenDelivery: vi.fn(async (id: string) => seen.has(id)),
    markSeenDelivery: vi.fn(async (id: string) => {
      seen.add(id);
    }),
    unmarkSeenDelivery: vi.fn(async (id: string) => {
      seen.delete(id);
    }),
    setPendingFire: vi.fn(async (info: PendingFire) => {
      pendingFire = info;
    }),
    clearPendingFire: vi.fn(async () => {
      pendingFire = null;
    }),
    getPendingFire: vi.fn(async () => pendingFire),
    watchdogArmed: vi.fn(async () => pendingFire !== null),
    recordStatus: vi.fn(async () => {}),
    getMergeGateFacts: vi.fn(async () => gateFacts()),
    getCiFix: vi.fn(async () => ciFix),
    setCiFix: vi.fn(async (state: CiFix | null) => {
      ciFix = state;
    }),
    // These tests are about the write path; shadow and per-event
    // enforcement have their own describe blocks.
    enforced: () => true,
    watchdogMinutes: watchdogMinutesFor,
    botLogin: async () => null,
    lastActivityAt: async () => null,
    markCompleted: vi.fn(async (at: string) => {
      completed = at;
    }),
    completedAt: vi.fn(async () => completed),
    getReconcileReported: vi.fn(async () => reconcileReported),
    setReconcileReported: vi.fn(async (s: string) => {
      reconcileReported = s;
    }),
    ...overrides,
  };
}

export function input(overrides: Partial<CoordinateInput> = {}): CoordinateInput {
  return {
    deliveryId: "delivery-1",
    owner: "hifi-phil",
    repo: "umbraco-mcp-ops",
    issueNumber: 412,
    payload: { action: "unknown" },
    ...overrides,
  };
}
