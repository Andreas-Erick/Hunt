// Habit Statistics (#26), shared core: the Habit Score over any sequence of Outcomes (days or Habit
// Weeks), and a Count Habit's daily amounts per month and totals per month of a year.
import { describe, expect, it } from "vitest";
import {
  HABIT_SCORE_WEIGHT,
  habitMonthAmounts,
  habitScore,
  habitYearTotals,
  summarizeHabitDays,
} from "@/mobile/huntCore";
import { habitTaskId } from "@/lib/dateUtils";
import type { HabitOutcome } from "@/lib/habitOutcome";
import type { Task } from "@/lib/domainTypes";

const many = (outcome: HabitOutcome | null, n: number) => Array.from({ length: n }, () => outcome);

describe("habitScore (0-100, weighted toward recent units; newest first)", () => {
  it("has no score before anything was Met or Missed", () => {
    expect(habitScore([])).toBeNull();
    expect(habitScore([...many("skipped", 5), "open", null])).toBeNull();
  });

  it("a steady record scores 100 when always Met and 0 when always Missed", () => {
    expect(habitScore(many("met", 60))).toBe(100);
    expect(habitScore(many("missed", 60))).toBe(0);
  });

  it("a long run then one miss today drops about 6 points, and the miss fades as Met days follow", () => {
    expect(habitScore(["missed", ...many("met", 100)])).toBe(94);
    expect(habitScore([...many("met", 30), "missed", ...many("met", 100)])).toBe(99);
  });

  it("leans on recent units: 30 Met after 30 Missed scores far above the 50% Success Rate", () => {
    expect(habitScore([...many("met", 30), ...many("missed", 30)])).toBe(88);
    expect(habitScore([...many("missed", 30), ...many("met", 30)])).toBe(12);
  });

  it("ignores Skipped, Open and unscheduled units, as if they were not there", () => {
    expect(habitScore(["open", "met", "skipped", null, "missed"])).toBe(habitScore(["met", "missed"]));
  });

  it("only a perfect record reads 100 and only an empty one 0", () => {
    expect(habitScore([...many("met", 400), "missed"])).toBe(99);
    expect(habitScore([...many("missed", 400), "met"])).toBe(1);
  });

  it("weights the newest unit at 2 / 31, so about the last 30 units dominate", () => {
    expect(HABIT_SCORE_WEIGHT).toBeCloseTo(0.0645, 4);
  });
});

describe("summaryFor(id).score() (the Habit Score of a Habit's days)", () => {
  it("scores every day since the Habit began", () => {
    const habit = { id: "h1", createdAt: new Date(2026, 10, 15, 8).getTime() };
    const met = (dayKey: string): Task => ({
      id: habitTaskId("h1", dayKey),
      title: "Stretch",
      notes: "",
      questId: null,
      habitId: "h1",
      status: "completed",
      completedAt: 1,
      rank: 0,
      accumulatedSeconds: 0,
      scheduledDate: dayKey,
      createdAt: 1,
      updatedAt: 1,
    });
    // 15-17 Met, today (18) Open: three Met days.
    const tasks = ["2026-11-15", "2026-11-16", "2026-11-17"].map(met);
    expect(summarizeHabitDays(tasks, "2026-11-18", [habit]).summaryFor("h1").score()).toBe(100);
    expect(summarizeHabitDays([], "2026-11-18", [habit]).summaryFor("h1").score()).toBe(0);
  });
});

const TODAY = "2026-11-18";

describe("habitMonthAmounts (a Count Habit's daily amounts for one month)", () => {
  const amounts: Record<string, number> = { "2026-11-02": 4, "2026-11-03": 1.5, "2026-11-18": 2 };
  const amountOn = (dayKey: string) => amounts[dayKey] ?? 0;

  it("lists every day of the month with its amount, marking days at or over the target", () => {
    const month = habitMonthAmounts({ monthKey: "2026-11", todayKey: TODAY, startKey: "2026-11-02", target: 3, amountOn });
    expect(month.days).toHaveLength(30);
    expect(month.days[0]).toEqual({ dayKey: "2026-11-01", day: 1, amount: null, reached: false });
    expect(month.days[1]).toEqual({ dayKey: "2026-11-02", day: 2, amount: 4, reached: true });
    expect(month.days[2]).toEqual({ dayKey: "2026-11-03", day: 3, amount: 1.5, reached: false });
    expect(month.days[3]).toEqual({ dayKey: "2026-11-04", day: 4, amount: 0, reached: false });
    expect(month.days[17].amount).toBe(2);
    // After today: no amount yet.
    expect(month.days[18].amount).toBeNull();
    expect(month.max).toBe(4);
  });

  it("scales to the target when no day reached it, and moves between the Habit's first month and today's", () => {
    const month = habitMonthAmounts({ monthKey: "2026-12", todayKey: TODAY, startKey: "2026-10-30", target: 5, amountOn });
    expect(month.monthKey).toBe("2026-11");
    expect(month.max).toBe(5);
    expect(month.nextMonthKey).toBeNull();
    expect(month.prevMonthKey).toBe("2026-10");
    const october = habitMonthAmounts({ monthKey: "2026-01", todayKey: TODAY, startKey: "2026-10-30", target: 5, amountOn });
    expect(october.monthKey).toBe("2026-10");
    expect(october.prevMonthKey).toBeNull();
    expect(october.days).toHaveLength(31);
  });
});

describe("habitYearTotals (a Count Habit's total per month of one year)", () => {
  const amounts: Record<string, number> = {
    "2025-12-31": 7,
    "2026-01-01": 2,
    "2026-01-31": 1.25,
    "2026-03-10": 4,
    "2026-11-18": 3,
    "2026-11-19": 50,
  };
  const amountOn = (dayKey: string) => amounts[dayKey] ?? 0;

  it("adds up each month of the year up to today; months outside the Habit's life have no total", () => {
    const year = habitYearTotals({ year: 2026, todayKey: TODAY, startKey: "2025-12-01", amountOn });
    expect(year.months.map((m) => m.total)).toEqual([3.25, 0, 4, 0, 0, 0, 0, 0, 0, 0, 3, null]);
    expect(year.months[0].monthKey).toBe("2026-01");
    expect(year.total).toBe(10.25);
    expect(year.prevYear).toBe(2025);
    expect(year.nextYear).toBeNull();
  });

  it("clamps the year to the Habit's first year and today's", () => {
    const year = habitYearTotals({ year: 2020, todayKey: TODAY, startKey: "2025-12-01", amountOn });
    expect(year.year).toBe(2025);
    expect(year.months.map((m) => m.total)).toEqual([...many(null, 11), 7]);
    expect(year.prevYear).toBeNull();
    expect(year.nextYear).toBe(2026);
  });
});
