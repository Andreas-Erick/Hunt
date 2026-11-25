import { describe, expect, it } from "vitest";
import { habitTaskId } from "@/lib/dateUtils";
import type { Habit, Task } from "@/lib/domainTypes";
import { summarizeHabitDays } from "@/lib/habitDay";
import { habitDayOutcome, habitStreakOf, type HabitOutcome } from "@/lib/habitOutcome";

const TODAY = "2026-05-11";
const HABIT: Habit = {
  id: "h",
  title: "Stretch",
  notes: "",
  questId: null,
  rank: 1000,
  createdAt: 1,
};

function dayTask(dateKey: string, overrides: Partial<Task> = {}): Task {
  return {
    id: habitTaskId(HABIT.id, dateKey),
    title: HABIT.title,
    notes: "",
    questId: null,
    habitId: HABIT.id,
    status: "queued",
    rank: 1000,
    accumulatedSeconds: 0,
    scheduledDate: dateKey,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("habitDayOutcome (shared Outcome of a habit day)", () => {
  it("is Met for a ticked day, today or earlier", () => {
    for (const dayKey of [TODAY, "2026-05-01"]) {
      const outcome = habitDayOutcome({
        habit: HABIT,
        dayKey,
        dayTask: dayTask(dayKey, { status: "completed" }),
        todayKey: TODAY,
      });
      expect(outcome, dayKey).toBe("met");
    }
  });

  it("is Open for today while it is not ticked, with or without its day Task", () => {
    expect(
      habitDayOutcome({ habit: HABIT, dayKey: TODAY, dayTask: dayTask(TODAY), todayKey: TODAY })
    ).toBe("open");
    expect(
      habitDayOutcome({ habit: HABIT, dayKey: TODAY, dayTask: undefined, todayKey: TODAY })
    ).toBe("open");
  });

  it("is Missed for a past day that ended unticked, or never got its day Task", () => {
    const yesterday = "2026-05-10";
    expect(
      habitDayOutcome({ habit: HABIT, dayKey: yesterday, dayTask: dayTask(yesterday), todayKey: TODAY })
    ).toBe("missed");
    expect(
      habitDayOutcome({ habit: HABIT, dayKey: yesterday, dayTask: undefined, todayKey: TODAY })
    ).toBe("missed");
  });

  it("keeps a past day Open while its focus session is still running across midnight", () => {
    const yesterday = "2026-05-10";
    expect(
      habitDayOutcome({
        habit: HABIT,
        dayKey: yesterday,
        dayTask: dayTask(yesterday, { status: "active" }),
        todayKey: TODAY,
      })
    ).toBe("open");
  });

  it("gives a day after today no Outcome yet", () => {
    expect(
      habitDayOutcome({ habit: HABIT, dayKey: "2026-05-12", dayTask: undefined, todayKey: TODAY })
    ).toBeNull();
  });

  it("reads an old Habit row with no Kind or Frequency as a daily Check Habit", () => {
    expect(
      habitDayOutcome({ habit: {}, dayKey: "2026-05-10", dayTask: undefined, todayKey: TODAY })
    ).toBe("missed");
  });
});

describe("habitStreakOf (Streak from Outcomes, newest day first)", () => {
  const streak = (...outcomes: (HabitOutcome | null)[]) => habitStreakOf(outcomes);

  it("counts Met days in a row, today included", () => {
    expect(streak("met", "met", "met", "missed", "met")).toBe(3);
  });

  it("passes over today while it is Open, so the Streak does not drop each morning", () => {
    expect(streak("open", "met", "met", "missed")).toBe(2);
  });

  it("is ended by a Missed day, and by an Open day before today", () => {
    expect(streak("missed", "met")).toBe(0);
    expect(streak("open", "open", "met")).toBe(0);
    expect(streak("met", "open", "met")).toBe(1);
  });

  it("passes over a day with no Outcome (unscheduled) and is 0 for no days", () => {
    expect(streak("met", null, "met")).toBe(2);
    expect(streak(null, "met", null, null, "met", "missed")).toBe(2);
    expect(streak()).toBe(0);
  });

  it("stops reading at the first day that ends it, so an endless day walk is safe", () => {
    function* endless(): Generator<HabitOutcome> {
      yield "met";
      yield "met";
      for (;;) yield "missed";
    }
    expect(habitStreakOf(endless())).toBe(2);
  });
});

describe("summarizeHabitDays outcomeOn (a Habit's Outcome on any day)", () => {
  function at(dateKey: string, hh: number, mm = 0): number {
    const [y, m, d] = dateKey.split("-").map(Number);
    return new Date(y, m - 1, d, hh, mm).getTime();
  }

  it("counts a tick after midnight for its scheduled day, not the day it was ticked", () => {
    const late = dayTask("2026-05-10", { status: "completed", completedAt: at(TODAY, 0, 30) });
    const s = summarizeHabitDays([late, dayTask(TODAY)], TODAY).summaryFor(HABIT.id);
    expect(s.outcomeOn("2026-05-10")).toBe("met");
    expect(s.outcomeOn(TODAY)).toBe("open");
  });

  it("judges each day from that Habit's own day Tasks", () => {
    const tasks = [
      dayTask("2026-05-09", { status: "completed", completedAt: at("2026-05-09", 8) }),
      dayTask("2026-05-10"),
      { ...dayTask("2026-05-08", { status: "completed" }), id: "other", habitId: "other" },
    ];
    const s = summarizeHabitDays(tasks, TODAY).summaryFor(HABIT.id);
    expect(s.outcomeOn("2026-05-08")).toBe("missed");
    expect(s.outcomeOn("2026-05-09")).toBe("met");
    expect(s.outcomeOn("2026-05-10")).toBe("missed");
    expect(s.outcomeOn(TODAY)).toBe("open");
    expect(s.outcomeOn("2026-05-12")).toBeNull();
  });

  it("bases the Streak on those Outcomes: an Open today keeps it, an Open yesterday ends it", () => {
    const ticked = (k: string) => dayTask(k, { status: "completed", completedAt: at(k, 8) });
    const base = [ticked("2026-05-08"), ticked("2026-05-09")];
    const summary = (yesterday: Task) =>
      summarizeHabitDays([...base, yesterday, dayTask(TODAY)], TODAY).summaryFor(HABIT.id);
    expect(summary(ticked("2026-05-10")).streak).toBe(3);
    expect(summary(dayTask("2026-05-10", { status: "active" })).streak).toBe(0);
  });
});

describe("Skipped habit days", () => {
  it("is Skipped for a day set aside, today or earlier", () => {
    for (const dayKey of [TODAY, "2026-05-01"]) {
      const outcome = habitDayOutcome({
        habit: HABIT,
        dayKey,
        dayTask: dayTask(dayKey, { skipped: true }),
        todayKey: TODAY,
      });
      expect(outcome, dayKey).toBe("skipped");
    }
  });

  it("is Met, not Skipped, once the day is ticked", () => {
    expect(
      habitDayOutcome({
        habit: HABIT,
        dayKey: TODAY,
        dayTask: dayTask(TODAY, { skipped: true, status: "completed" }),
        todayKey: TODAY,
      })
    ).toBe("met");
  });

  it("lets the Streak pass over Skipped days, neither adding to nor breaking it", () => {
    expect(habitStreakOf(["met", "skipped", "skipped", "met", "missed"])).toBe(2);
    expect(habitStreakOf(["skipped", "met", "met"])).toBe(2);
    expect(habitStreakOf(["open", "skipped", "met"])).toBe(1);
    expect(habitStreakOf(["skipped", "missed", "met"])).toBe(0);
  });

  it("carries a Skipped day through summarizeHabitDays", () => {
    const at8 = (k: string) => {
      const [y, m, d] = k.split("-").map(Number);
      return new Date(y, m - 1, d, 8).getTime();
    };
    const tasks = [
      dayTask("2026-05-08", { status: "completed", completedAt: at8("2026-05-08") }),
      dayTask("2026-05-09", { skipped: true }),
      dayTask("2026-05-10", { status: "completed", completedAt: at8("2026-05-10") }),
      dayTask(TODAY),
    ];
    const s = summarizeHabitDays(tasks, TODAY).summaryFor(HABIT.id);
    expect(s.outcomeOn("2026-05-09")).toBe("skipped");
    expect(s.streak).toBe(2);
  });
});
