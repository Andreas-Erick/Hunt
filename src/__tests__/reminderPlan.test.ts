// @vitest-environment node
// The phone's Reminder Plan (ADR-0007): what the page hands the Android shell after every save
// and sync. The shell only arms alarms for it, so which reminders it holds is decided here, by the
// shared dueReminders rule, over a window that reaches a little back (a late alarm still fires)
// and far enough ahead to cover the days Hunt stays closed.
import { describe, expect, it } from "vitest";
import { REMINDER_PLAN_AHEAD_MS, REMINDER_PLAN_MAX, reminderPlan } from "@/mobile/huntCore";
import type { Task } from "@/lib/domainTypes";

const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const NOW = at(25, 9);

function task(id: string, day: number, time: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    notes: "",
    questId: null,
    status: "queued",
    rank: 1000,
    accumulatedSeconds: 0,
    scheduledDate: `2026-11-${String(day).padStart(2, "0")}`,
    reminderTime: time,
    createdAt: 10,
    updatedAt: 500,
    ...overrides,
  };
}

describe("reminderPlan", () => {
  it("lists the reminders still to come, earliest first, each with what the shell needs to show and open it", () => {
    const plan = reminderPlan({ tasks: [task("b", 26, "08:00"), task("a", 25, "18:45")] }, NOW);
    expect(plan.version).toBe(1);
    expect(plan.reminders).toEqual([
      { kind: "task", key: "task:a:2026-11-25T18:45", itemId: "a", title: "Task a", dateKey: "2026-11-25", time: "18:45", fireAt: at(25, 18, 45) },
      { kind: "task", key: "task:b:2026-11-26T08:00", itemId: "b", title: "Task b", dateKey: "2026-11-26", time: "08:00", fireAt: at(26, 8) },
    ]);
  });

  it("keeps a reminder from the last 10 minutes, so an alarm that runs late still fires, and drops older ones", () => {
    const plan = reminderPlan({ tasks: [task("late", 25, "08:51"), task("gone", 25, "08:49")] }, NOW);
    expect(plan.reminders.map((r) => r.itemId)).toEqual(["late"]);
  });

  it("leaves out done Tasks, so a Task finished here or synced as done goes quiet", () => {
    const plan = reminderPlan({ tasks: [task("done", 25, "18:00", { status: "completed" }), task("open", 25, "19:00")] }, NOW);
    expect(plan.reminders.map((r) => r.itemId)).toEqual(["open"]);
  });

  it("reaches a week ahead, so reminders arrive while Hunt stays closed", () => {
    expect(REMINDER_PLAN_AHEAD_MS).toBe(7 * 24 * 60 * 60_000);
    const dec2 = { scheduledDate: "2026-12-02" };
    const plan = reminderPlan({ tasks: [task("in", 2, "08:59", dec2), task("out", 2, "09:00", dec2)] }, NOW);
    expect(plan.reminders.map((r) => r.itemId)).toEqual(["in"]);
  });

  it("holds at most the earliest REMINDER_PLAN_MAX reminders, so the shell's file stays small", () => {
    const tasks = Array.from({ length: REMINDER_PLAN_MAX + 5 }, (_, i) =>
      task(`t${String(i).padStart(3, "0")}`, 25, `${String(10 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`),
    );
    const plan = reminderPlan({ tasks: tasks.reverse() }, NOW);
    expect(plan.reminders).toHaveLength(64);
    expect(plan.reminders[0].itemId).toBe("t000");
    expect(plan.reminders[63].itemId).toBe("t063");
  });
});
