import { describe, expect, it } from "vitest";
import { habitTaskId } from "@/lib/dateUtils";
import type { Habit, Task } from "@/lib/domainTypes";
import { summarizeHabitDays } from "@/lib/habitDay";
import { habitSuccessRate, habitSuccessRateLabel, habitWeekStrip } from "@/lib/habitInsight";
import type { HabitOutcome } from "@/lib/habitOutcome";

describe("habitWeekStrip (the Habit card's last 7 days)", () => {
  it("lists the 7 days ending today, oldest first, each with its Outcome and a plain-words name", () => {
    const outcomes: Record<string, HabitOutcome | null> = {
      "2026-05-05": "met",
      "2026-05-06": "missed",
      "2026-05-07": "skipped",
      "2026-05-08": null,
      "2026-05-09": "met",
      "2026-05-10": "missed",
      "2026-05-11": "open",
    };
    const strip = habitWeekStrip("2026-05-11", (day) => outcomes[day] ?? null);
    expect(strip.map((d) => d.dayKey)).toEqual(Object.keys(outcomes));
    expect(strip.map((d) => d.outcome)).toEqual(Object.values(outcomes));
    expect(strip.map((d) => d.weekday)).toEqual(["T", "W", "T", "F", "S", "S", "M"]);
    expect(strip.map((d) => d.label)).toEqual([
      "Tue 5: Met",
      "Wed 6: Missed",
      "Thu 7: Skipped",
      "Fri 8: Not scheduled",
      "Sat 9: Met",
      "Sun 10: Missed",
      "Mon 11 (today): Open",
    ]);
  });
});

describe("habitSuccessRateLabel", () => {
  it("shows a whole percent, and nothing before any day was Met or Missed", () => {
    expect(habitSuccessRateLabel(null)).toBeNull();
    expect(habitSuccessRateLabel(2 / 3)).toBe("67%");
    expect(habitSuccessRateLabel(0)).toBe("0%");
    expect(habitSuccessRateLabel(1)).toBe("100%");
    expect(habitSuccessRateLabel(0.996)).toBe("99%");
  });
});

describe("habitSuccessRate (shared Success Rate: Met / (Met + Missed))", () => {
  it("has no Success Rate without any history", () => {
    expect(habitSuccessRate([])).toBeNull();
  });

  it("has no Success Rate when every unit was Skipped, unscheduled or is still Open", () => {
    expect(habitSuccessRate(["skipped", "skipped", null, "open"])).toBeNull();
  });

  it("is the share of Met among Met and Missed, ignoring Skipped, Open and unscheduled", () => {
    expect(habitSuccessRate(["met", "missed", "met", "skipped", null, "open", "met", "missed"])).toBe(0.6);
  });

  it("is 1 when every judged unit was Met, and 0 when every one was Missed", () => {
    expect(habitSuccessRate(["met", "skipped", "met"])).toBe(1);
    expect(habitSuccessRate(["missed", null, "missed"])).toBe(0);
  });

  it("reads any iterable of Outcomes, so Habit Weeks drop in like days", () => {
    function* weeks() {
      yield "met" as const;
      yield "missed" as const;
      yield "met" as const;
      yield "met" as const;
    }
    expect(habitSuccessRate(weeks())).toBe(0.75);
  });
});

describe("summarizeHabitDays(...).summaryFor(id).successRate() (since the Habit began)", () => {
  const TODAY = "2026-05-11"; // a Monday
  const began = new Date(2026, 4, 6, 9).getTime(); // Wed 2026-05-06
  const habit: Habit = { id: "h", title: "Stretch", notes: "", questId: null, rank: 1000, createdAt: began };

  function dayTask(dateKey: string, overrides: Partial<Task> = {}): Task {
    return {
      id: habitTaskId("h", dateKey),
      title: "Stretch",
      notes: "",
      questId: null,
      habitId: "h",
      status: "queued",
      rank: 1000,
      accumulatedSeconds: 0,
      scheduledDate: dateKey,
      createdAt: began,
      updatedAt: began,
      ...overrides,
    };
  }

  it("has no Success Rate for a Habit that began today", () => {
    const fresh = { ...habit, createdAt: new Date(2026, 4, 11, 8).getTime() };
    expect(summarizeHabitDays([], TODAY, [fresh]).summaryFor("h").successRate()).toBeNull();
  });

  it("counts every day since it began: Met, Missed (even with no day Task), Skipped passed over", () => {
    const tasks = [
      dayTask("2026-05-06", { status: "completed" }),
      dayTask("2026-05-07", { status: "completed" }),
      dayTask("2026-05-08", { skipped: true }),
      // 05-09 and 05-10 never got a day Task: Missed.
      dayTask("2026-05-11", { status: "completed" }), // today, Met
    ];
    // Met 3 (06, 07, 11), Missed 2 (09, 10).
    expect(summarizeHabitDays(tasks, TODAY, [habit]).summaryFor("h").successRate()).toBe(0.6);
  });

  it("leaves out days its Frequency did not ask for", () => {
    const weekdays: Habit = {
      ...habit,
      frequencyHistory: [{ effectiveFrom: "2026-05-06", frequency: { type: "weekdays", weekdays: [1, 3] } }],
    };
    // Asked: Wed 05-06 (Met) and Mon 05-11 (today, Open); the days between were not asked for.
    const tasks = [dayTask("2026-05-06", { status: "completed" })];
    expect(summarizeHabitDays(tasks, TODAY, [weekdays]).summaryFor("h").successRate()).toBe(1);
  });
});
