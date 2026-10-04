import { describe, expect, it } from "vitest";
import * as controls from "../../src/db/controls";
import * as transitions from "../../src/db/transitions";
import { testDb } from "./sqlite-d1";

describe("db/controls — a repo's switches, against real SQLite", () => {
  it("set writes the switch and logs a control_changed row together; setting again updates it", async () => {
    const db = testDb();
    await controls.set(db, "Hifi-Phil", "umbraco-mcp-ops", "sweep", false, "octo");
    await controls.set(db, "hifi-phil", "umbraco-mcp-ops", "sweep", true, "hubot");
    expect(await controls.forRepo(db, "HIFI-PHIL", "umbraco-mcp-ops")).toMatchObject([{ control: "sweep", enabled: 1, updated_by: "hubot" }]);
    const log = await transitions.forRepo(db, "hifi-phil", "umbraco-mcp-ops");
    expect(log.map((r) => [r.event, r.to_effect, r.actor])).toEqual([
      ["control_changed", '{"control":"sweep","enabled":true,"by":"hubot"}', "hubot"],
      ["control_changed", '{"control":"sweep","enabled":false,"by":"octo"}', "octo"],
    ]);
  });

  it("reposWithOff: just the repos where that control is off", async () => {
    const db = testDb();
    await controls.set(db, "o", "a", "sweep", false, "x");
    await controls.set(db, "o", "b", "sweep", true, "x");
    await controls.set(db, "o", "c", "other", false, "x");
    expect([...(await controls.reposWithOff(db, "sweep"))]).toEqual(["o/a"]);
  });
});
