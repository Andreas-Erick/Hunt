import { describe, expect, it } from "vitest";
import { habitTaskId } from "@/lib/dateUtils";
import type { Habit, HabitFrequency, Task } from "@/lib/domainTypes";
import { habitTodayTally, summarizeHabitDays } from "@/lib/habitDay";
import { habitStreakOf } from "@/lib/habitOutcome";

// Skipped days (#18) and unscheduled days (#19) together. 2026-05-11 is a Monday.
const TODAY = "2026-05-11";
const MON_WED_FRI: HabitFrequency = { type: "weekdays", weekdays: [1, 3, 5] };

function habit(id: string, overrides: Partial<Habit> = {}): Habit {
  return { id, title: id, notes: "", questId: null, rank: 1000, createdAt: 1, ...overrides };
}

function dayTask(habitId: string, dateKey: string, overrides: Partial<Task> = {}): Task {
  return {
    id: habitTaskId(habitId, dateKey),
    title: habitId,
    notes: "",
    questId: null,
    habitId,
    status: "queued",
    rank: 1000,
    accumulatedSeconds: 0,
    scheduledDate: dateKey,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("Skipped and unscheduled days together", () => {
  it("passes over both Skipped days and days with no Outcome in a Streak", () => {
    expect(habitStreakOf(["open", "skipped", null, "met", null, "skipped", "met", "missed"])).toBe(2);
  });

  it("keeps a weekday Habit's Streak across a Skipped Friday and the weekend", () => {
    const h = habit("h", { frequencyHistory: [{ effectiveFrom: "2026-05-01", frequency: MON_WED_FRI }] });
    const tasks = [
      dayTask("h", "2026-05-06", { status: "completed" }), // Wed: Met
      dayTask("h", "2026-05-08", { skipped: true }), // Fri: Skipped
      dayTask("h", TODAY, { status: "completed" }), // Mon: Met
    ];
    const s = summarizeHabitDays(tasks, TODAY, [h]).summaryFor("h");
    expect(s.outcomeOn("2026-05-08")).toBe("skipped");
    expect(s.outcomeOn("2026-05-09")).toBeNull();
    expect(s.streak).toBe(2);
  });

  it("counts only scheduled, non-Skipped Habits toward done today", () => {
    const habits = [
      habit("daily"),
      habit("skipped"),
      habit("weekend", { frequencyHistory: [{ effectiveFrom: "2026-05-01", frequency: { type: "weekdays", weekdays: [0, 6] } }] }),
      habit("open"),
    ];
    const tasks = [
      dayTask("daily", TODAY, { status: "completed" }),
      dayTask("skipped", TODAY, { skipped: true }),
    ];
    const { summaryFor } = summarizeHabitDays(tasks, TODAY, habits);
    expect(habitTodayTally(habits, summaryFor, TODAY)).toEqual({ done: 1, asked: 2 });
  });
});
