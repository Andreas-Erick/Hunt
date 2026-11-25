import { describe, expect, it } from "vitest";
import { habitTaskId, toLocalDateKey } from "@/lib/dateUtils";
import type { Task } from "@/lib/domainTypes";
import { completionDateKey, habitRowMode, summarizeHabitDays } from "@/lib/habitDay";
import { computeActivityHeatmap } from "@/lib/reviewAnalytics";

describe("habitRowMode (how a Habit card's row logs today, on both apps)", () => {
  const today = { askedToday: true, skipState: "open" as const, doneToday: false };

  it("logs by the Habit's Kind on a day it asks for: a tick, +1 / a total, or a Slip", () => {
    expect(habitRowMode({}, today)).toEqual({ mode: "tick", focusable: true });
    expect(habitRowMode({ kind: "count" }, today)).toEqual({ mode: "count", focusable: true });
    expect(habitRowMode({ kind: "avoid" }, today)).toEqual({ mode: "slip", focusable: false });
  });

  it("is set aside on a Skipped day and plain on a day not asked for, whatever the Kind", () => {
    for (const kind of ["check", "count", "avoid"] as const) {
      expect(habitRowMode({ kind }, { ...today, skipState: "skipped" })).toEqual({ mode: "skipped", focusable: false });
      expect(habitRowMode({ kind }, { ...today, askedToday: false })).toEqual({ mode: "unasked", focusable: false });
    }
  });

  it("offers no focus once today is done", () => {
    expect(habitRowMode({ kind: "count" }, { ...today, doneToday: true })).toEqual({ mode: "count", focusable: false });
  });
});

function at(dateKey: string, hh: number, mm = 0): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(y, m - 1, d, hh, mm).getTime();
}

function habitTask(habitId: string, dateKey: string, overrides: Partial<Task> = {}): Task {
  return {
    id: habitTaskId(habitId, dateKey),
    title: "Stretch",
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

describe("completionDateKey (shared completion-date rule)", () => {
  it("is null for a task that is not completed", () => {
    expect(completionDateKey(habitTask("h", "2026-05-10"))).toBeNull();
  });

  it("counts a habit instance for its own day even when ticked after midnight", () => {
    const late = habitTask("h", "2026-05-10", {
      status: "completed",
      completedAt: at("2026-05-11", 0, 30),
    });
    expect(completionDateKey(late)).toBe("2026-05-10");
  });

  it("counts a regular task for the day it was finished, then scheduledDate, then updatedAt", () => {
    const base: Task = { ...habitTask("h", "2026-05-10"), habitId: undefined, status: "completed" };
    expect(completionDateKey({ ...base, completedAt: at("2026-05-12", 9) })).toBe("2026-05-12");
    expect(completionDateKey({ ...base, completedAt: undefined })).toBe("2026-05-10");
    expect(
      completionDateKey({
        ...base,
        completedAt: undefined,
        scheduledDate: "junk",
        updatedAt: at("2026-05-03", 12),
      })
    ).toBe("2026-05-03");
  });
});

describe("summarizeHabitDays", () => {
  const today = "2026-05-11";

  it("finds today's instance, completed days and the streak", () => {
    const tasks = [
      habitTask("h", "2026-05-09", { status: "completed", completedAt: at("2026-05-09", 8) }),
      habitTask("h", "2026-05-10", { status: "completed", completedAt: at("2026-05-11", 0, 30) }),
      habitTask("h", today),
    ];
    const s = summarizeHabitDays(tasks, today).summaryFor("h");
    expect(s.todayTask?.id).toBe(habitTaskId("h", today));
    expect(s.doneToday).toBe(false);
    expect([...s.completedDates].sort()).toEqual(["2026-05-09", "2026-05-10"]);
    expect(s.streak).toBe(2);
  });

  it("prefers the deterministic id over another row scheduled today", () => {
    const stray = { ...habitTask("h", today), id: "legacy-row" };
    const canonical = habitTask("h", today, { status: "completed", completedAt: at(today, 7) });
    for (const order of [[stray, canonical], [canonical, stray]]) {
      const s = summarizeHabitDays(order, today).summaryFor("h");
      expect(s.todayTask?.id).toBe(canonical.id);
      expect(s.doneToday).toBe(true);
    }
  });

  it("gives an empty summary to a habit without tasks", () => {
    const s = summarizeHabitDays([], today).summaryFor("nope");
    expect(s).toMatchObject({ todayTask: undefined, doneToday: false, streak: 0 });
    expect(s.completedDates.size).toBe(0);
  });

  it("agrees with the Review heatmap on the day a late-ticked habit counts for", () => {
    const late = habitTask("h", "2026-05-10", {
      status: "completed",
      completedAt: at("2026-05-11", 0, 30),
    });
    const streakDays = summarizeHabitDays([late], today).summaryFor("h").completedDates;
    const heat = computeActivityHeatmap({ logs: [], tasks: [late], scope: "OTHER", todayKey: today });
    const heatDays = heat.columns
      .flatMap((c) => c.cells)
      .filter((c) => c.completedTasks > 0)
      .map((c) => c.dateKey);
    expect(heatDays).toEqual([...streakDays]);
    expect(toLocalDateKey(late.completedAt!)).toBe(today);
  });
});
