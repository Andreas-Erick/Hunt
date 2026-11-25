// Habit detail Calendar tab (#25): the shared month grid of Outcomes and the shared "correct a
// habit day" row both apps write.
import { describe, expect, it } from "vitest";
import { correctHabitDayRow, habitMonth, habitStartKey, summarizeHabitDays } from "@/mobile/huntCore";
import { habitTaskId } from "@/lib/dateUtils";
import type { Task } from "@/lib/domainTypes";
import type { HabitOutcome } from "@/lib/habitOutcome";

const TODAY = "2026-11-18";

/** Every day Missed unless listed. */
function outcomes(byDay: Record<string, HabitOutcome | null>) {
  return (dayKey: string): HabitOutcome | null =>
    dayKey in byDay ? byDay[dayKey] : dayKey > TODAY ? null : "missed";
}

describe("habitMonth (shared month grid of Outcomes)", () => {
  it("lays a month out in Monday-first weeks, with blanks outside the month", () => {
    const month = habitMonth({ monthKey: "2026-11", todayKey: TODAY, startKey: "2026-01-01", outcomeOn: outcomes({}) });
    // 1 Nov 2026 is a Sunday: six blanks lead the first week.
    expect(month.weeks[0].map((d) => d?.dayKey ?? null)).toEqual([null, null, null, null, null, null, "2026-11-01"]);
    expect(month.weeks[1][0]?.dayKey).toBe("2026-11-02");
    // 30 Nov is a Monday: the last week holds it and six blanks.
    expect(month.weeks[month.weeks.length - 1].map((d) => d?.dayKey ?? null)).toEqual([
      "2026-11-30", null, null, null, null, null, null,
    ]);
    expect(month.weeks.flat().filter(Boolean)).toHaveLength(30);
  });

  it("carries each day's Outcome; a day after today, before the Habit began, or without an Outcome cannot be corrected", () => {
    const month = habitMonth({
      monthKey: "2026-11",
      todayKey: TODAY,
      startKey: "2026-11-03",
      outcomeOn: outcomes({ "2026-11-05": "met", "2026-11-06": "skipped", "2026-11-07": null, [TODAY]: "open" }),
    });
    const day = (key: string) => month.weeks.flat().find((d) => d?.dayKey === key);
    expect(day("2026-11-02")).toMatchObject({ day: 2, outcome: null, correctable: false });
    expect(day("2026-11-04")).toMatchObject({ outcome: "missed", correctable: true });
    expect(day("2026-11-05")).toMatchObject({ outcome: "met", correctable: true });
    expect(day("2026-11-06")).toMatchObject({ outcome: "skipped", correctable: true });
    expect(day("2026-11-07")).toMatchObject({ outcome: null, correctable: false });
    expect(day(TODAY)).toMatchObject({ outcome: "open", correctable: true });
    expect(day("2026-11-19")).toMatchObject({ outcome: null, correctable: false });
  });

  it("moves between months from the Habit's first month to today's, and clamps a month outside them", () => {
    const at = (monthKey: string) =>
      habitMonth({ monthKey, todayKey: TODAY, startKey: "2025-12-20", outcomeOn: outcomes({}) });
    expect(at("2026-11")).toMatchObject({ monthKey: "2026-11", prevMonthKey: "2026-10", nextMonthKey: null });
    expect(at("2026-01")).toMatchObject({ prevMonthKey: "2025-12", nextMonthKey: "2026-02" });
    expect(at("2025-12")).toMatchObject({ prevMonthKey: null, nextMonthKey: "2026-01" });
    expect(at("2024-03").monthKey).toBe("2025-12");
    expect(at("2027-04").monthKey).toBe("2026-11");
  });
});

function dayTask(overrides: Partial<Task> = {}): Task {
  return {
    id: habitTaskId("h1", "2026-11-10"),
    title: "Stretch",
    notes: "",
    questId: null,
    habitId: "h1",
    status: "queued",
    rank: 1000,
    accumulatedSeconds: 0,
    scheduledDate: "2026-11-10",
    createdAt: 10,
    updatedAt: 500,
    ...overrides,
  };
}

const outcomeOf = (task: Task) => summarizeHabitDays([task], TODAY).summaryFor("h1").outcomeOn("2026-11-10");

describe("correctHabitDayRow (shared calendar correction)", () => {
  it("ticks a Missed past day: Met, stamped newer", () => {
    const met = correctHabitDayRow(dayTask(), "met", 9_000);
    expect(outcomeOf(met)).toBe("met");
    expect(met.updatedAt).toBe(9_000);
  });

  it("unticks a Met day back to Missed", () => {
    const met = dayTask({ status: "completed", completedAt: 700 });
    const none = correctHabitDayRow(met, "none", 9_000);
    expect(outcomeOf(none)).toBe("missed");
    expect(none.completedAt).toBeUndefined();
  });

  it("Skips a Met day: it is no longer ticked", () => {
    const skipped = correctHabitDayRow(dayTask({ status: "completed", completedAt: 700 }), "skipped", 9_000);
    expect(outcomeOf(skipped)).toBe("skipped");
    expect(skipped.status).toBe("queued");
  });

  it("un-Skips a Skipped day and ticks a Skipped day", () => {
    expect(outcomeOf(correctHabitDayRow(dayTask({ skipped: true }), "none", 9_000))).toBe("missed");
    const met = correctHabitDayRow(dayTask({ skipped: true }), "met", 9_000);
    expect(outcomeOf(met)).toBe("met");
    expect(met.skipped).toBeUndefined();
  });

  it("returns the same row when the day already reads that way, so nothing is written", () => {
    const plain = dayTask();
    expect(correctHabitDayRow(plain, "none", 9_000)).toBe(plain);
    const skipped = dayTask({ skipped: true });
    expect(correctHabitDayRow(skipped, "skipped", 9_000)).toBe(skipped);
    const met = dayTask({ status: "completed", completedAt: 700 });
    expect(correctHabitDayRow(met, "met", 9_000)).toBe(met);
  });

  it("leaves a day whose focus is running alone", () => {
    const active = dayTask({ status: "active" });
    expect(correctHabitDayRow(active, "skipped", 9_000)).toBe(active);
  });
});

describe("correctHabitDayRow on a Count Habit day (the Count rules hold)", () => {
  const COUNT = { id: "h1", kind: "count" as const, target: 3, createdAt: 1 };
  const countOutcome = (task: Task) =>
    summarizeHabitDays([task], TODAY, [COUNT]).summaryFor("h1").outcomeOn("2026-11-10");

  it("ticking a Count day raises its total to the target, keeping a larger one", () => {
    const met = correctHabitDayRow(dayTask({ amount: 1 }), "met", 9_000, COUNT);
    expect(met.amount).toBe(3);
    expect(met.status).toBe("completed");
    expect(countOutcome(met)).toBe("met");
    const over = dayTask({ amount: 5, status: "completed", completedAt: 700 });
    expect(correctHabitDayRow(over, "met", 9_000, COUNT)).toBe(over);
  });

  it("unticking or Skipping a Count day clears its total to 0", () => {
    const met = dayTask({ amount: 4, status: "completed", completedAt: 700 });
    const none = correctHabitDayRow(met, "none", 9_000, COUNT);
    expect(none.amount).toBe(0);
    expect(none.status).toBe("queued");
    expect("completedAt" in none && none.completedAt === undefined).toBe(true);
    expect(countOutcome(none)).toBe("missed");

    const skipped = correctHabitDayRow(dayTask({ amount: 2 }), "skipped", 9_000, COUNT);
    expect(skipped.amount).toBe(0);
    expect(skipped.skipped).toBe(true);
    expect(countOutcome(skipped)).toBe("skipped");
    expect(countOutcome(correctHabitDayRow(met, "skipped", 9_000, COUNT))).toBe("skipped");
  });

  it("un-Skips a Skipped Count day, and writes nothing when the day already reads that way", () => {
    const skipped = dayTask({ skipped: true });
    const none = correctHabitDayRow(skipped, "none", 9_000, COUNT);
    expect(none.skipped).toBeUndefined();
    expect(countOutcome(none)).toBe("missed");
    const plain = dayTask({ amount: 0 });
    expect(correctHabitDayRow(plain, "none", 9_000, COUNT)).toBe(plain);
    expect(correctHabitDayRow(skipped, "skipped", 9_000, COUNT)).toBe(skipped);
  });

  it("Untick clears a partial total too", () => {
    expect(correctHabitDayRow(dayTask({ amount: 2 }), "none", 9_000, COUNT).amount).toBe(0);
  });
});

describe("habitStartKey (a Habit's first calendar day)", () => {
  it("is the local day the Habit was made, or today for a row without a usable createdAt", () => {
    expect(habitStartKey({ createdAt: new Date(2026, 10, 3, 9, 30).getTime() }, TODAY)).toBe("2026-11-03");
    expect(habitStartKey({ createdAt: Number.NaN }, TODAY)).toBe(TODAY);
    expect(habitStartKey({ createdAt: new Date(2027, 0, 1).getTime() }, TODAY)).toBe(TODAY);
  });
});
