import { describe, expect, it } from "vitest";
import { findStaleGoals } from "./goal-followup.js";

describe("findStaleGoals", () => {
  it("只返回超过阈值的目标并按未复核天数排序", () => {
    const now = new Date("2026-11-17T00:00:00Z");
    const goals = findStaleGoals([
      { id: "new", content: "新目标", updatedAt: "2026-11-16T00:00:00Z" },
      { id: "old", content: "旧目标", updatedAt: "2026-10-01T00:00:00Z" },
      { id: "week", content: "一周目标", updatedAt: "2026-11-10T00:00:00Z" },
    ], now);
    expect(goals.map((g) => g.id)).toEqual(["old", "week"]);
    expect(goals[0]?.daysInactive).toBe(47);
  });
});
