// @vitest-environment node
// Ended Habits (GLOSSARY: Ended Habit), through the shared core both apps import: days past the end
// date have no Outcome, an Ended Habit leaves Today and the Widget Snapshot, and a restart (end date
// cleared or moved) never counts the days it was Ended against its Streak or Success Rate.
import { describe, expect, it } from "vitest";
import { habitTaskId } from "@/lib/dateUtils";
import type { Habit, Task } from "@/lib/domainTypes";
import {
  buildWidgetSnapshot,
  habitDayOutcome,
  habitTodayTaskAfterEdit,
  isEndedHabit,
  missingHabitRows,
  summarizeHabitDays,
  withHabitEndDate,
} from "@/mobile/huntCore";

const TODAY = "2026-05-20";
const HABIT: Habit = { id: "h", title: "Stretch", notes: "", questId: null, rank: 1000, createdAt: 1 };

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

const met = (dateKey: string) => dayTask(dateKey, { status: "completed", completedAt: 1 });

/** Met every day from `from` to `to` (inclusive, both in May 2026). */
function metDays(from: number, to: number): Task[] {
  const tasks: Task[] = [];
  for (let d = from; d <= to; d++) tasks.push(met(`2026-05-${String(d).padStart(2, "0")}`));
  return tasks;
}

describe("Ended Habit: Outcomes", () => {
  it("has an Outcome up to and including its end date, and none after it", () => {
    const habit = { ...HABIT, endDate: "2026-05-15" };
    const outcome = (dayKey: string, task?: Task) => habitDayOutcome({ habit, dayKey, dayTask: task, todayKey: TODAY });
    expect(outcome("2026-05-15", met("2026-05-15"))).toBe("met");
    expect(outcome("2026-05-14")).toBe("missed");
    expect(outcome("2026-05-16")).toBeNull();
    expect(outcome("2026-05-17", met("2026-05-17"))).toBeNull();
    expect(outcome(TODAY)).toBeNull();
  });

  it("keeps its final Streak: the days after the end date pass over, they do not break it", () => {
    const habit = { ...HABIT, endDate: "2026-05-15" };
    const summary = summarizeHabitDays(metDays(10, 15), TODAY, [habit]).summaryFor(HABIT.id);
    expect(summary.streak).toBe(6);
  });

  it("is an Ended Habit only once its end date is past", () => {
    expect(isEndedHabit({ endDate: "2026-05-19" }, TODAY)).toBe(true);
    expect(isEndedHabit({ endDate: TODAY }, TODAY)).toBe(false);
    expect(isEndedHabit({}, TODAY)).toBe(false);
  });
});

/** Each Outcome from `from` to `to` (inclusive, both in May 2026). */
function outcomesOf(habit: Habit, tasks: Task[], from: number, to: number) {
  const { outcomeOn } = summarizeHabitDays(tasks, TODAY, [habit]).summaryFor(habit.id);
  const out: (string | null)[] = [];
  for (let d = from; d <= to; d++) out.push(outcomeOn(`2026-05-${String(d).padStart(2, "0")}`));
  return out;
}

describe("Ended Habit: restart", () => {
  const ended: Habit = { ...HABIT, endDate: "2026-05-12" };

  it("clearing the end date restarts it from today, and the days it was Ended have no Outcome", () => {
    const restarted = { ...ended, ...withHabitEndDate(ended, null, TODAY) };
    expect(restarted.endDate).toBeUndefined();
    expect(isEndedHabit(restarted, TODAY)).toBe(false);
    // Met 8..12, Ended 13..19, Open today.
    expect(outcomesOf(restarted, metDays(8, 12), 8, 20)).toEqual([
      "met", "met", "met", "met", "met", null, null, null, null, null, null, null, "open",
    ]);
  });

  it("the gap is never Missed, so the Streak runs on across it", () => {
    const restarted = { ...ended, ...withHabitEndDate(ended, null, TODAY) };
    const tasks = [...metDays(8, 12), met(TODAY)];
    expect(summarizeHabitDays(tasks, TODAY, [restarted]).summaryFor(HABIT.id).streak).toBe(6);
    // Success Rate is Met / (Met + Missed): no Missed day in the gap means the gap leaves it alone.
    expect(outcomesOf(restarted, tasks, 8, 20).filter((o) => o === "missed")).toEqual([]);
  });

  it("moving the end date to today or later restarts it the same way", () => {
    const moved = { ...ended, ...withHabitEndDate(ended, "2026-06-30", TODAY) };
    expect(moved.endDate).toBe("2026-06-30");
    expect(isEndedHabit(moved, TODAY)).toBe(false);
    expect(outcomesOf(moved, [], 13, 20)).toEqual([null, null, null, null, null, null, null, "open"]);
  });

  it("moving the end date of an Ended Habit to another past day only corrects it: it stays Ended", () => {
    const moved = { ...ended, ...withHabitEndDate(ended, "2026-05-14", TODAY) };
    expect(isEndedHabit(moved, TODAY)).toBe(true);
    expect(moved.endedSpans).toBeUndefined();
    expect(outcomesOf(moved, metDays(13, 14), 12, 15)).toEqual(["missed", "met", "met", null]);
  });

  it("a Habit ended and restarted twice keeps both gaps", () => {
    let habit: Habit = { ...HABIT, endDate: "2026-05-03" };
    habit = { ...habit, ...withHabitEndDate(habit, null, "2026-05-06") };
    habit = { ...habit, ...withHabitEndDate(habit, "2026-05-10", "2026-05-06") };
    habit = { ...habit, ...withHabitEndDate(habit, null, "2026-05-15") };
    expect(habit.endedSpans).toEqual([
      { from: "2026-05-04", to: "2026-05-05" },
      { from: "2026-05-11", to: "2026-05-14" },
    ]);
  });

  it("restarting the day after it ended leaves no gap to keep", () => {
    const fresh = { ...HABIT, endDate: "2026-05-19" };
    expect(withHabitEndDate(fresh, null, TODAY)).toEqual({ endDate: undefined, endedSpans: undefined });
  });
});

describe("Ended Habit: Today and the Widget Snapshot", () => {
  const ended: Habit = { ...HABIT, endDate: "2026-05-19" };
  const state = (habits: Habit[], tasks: Task[] = []) => ({
    quests: [],
    tasks,
    habits,
    timeLogs: [],
    deletedQuestIds: [],
    deletedTaskIds: [],
    deletedLogIds: [],
    activeFocus: { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 0 },
    lastSyncedAt: 0,
  });

  it("gets no day Task after its end date, and still gets one on its last day", () => {
    expect(missingHabitRows(state([ended]), TODAY)).toEqual([]);
    expect(missingHabitRows(state([ended]), "2026-05-19").map((t) => t.id)).toEqual([
      habitTaskId(HABIT.id, "2026-05-19"),
    ]);
  });

  it("is left off the Day Widget, even when a day Task for today already exists", () => {
    const snapshot = buildWidgetSnapshot(state([ended], [dayTask(TODAY)]), TODAY, "neon");
    expect(snapshot.days[0].today).toEqual([]);
    const current = buildWidgetSnapshot(state([HABIT], [dayTask(TODAY)]), TODAY, "neon");
    expect(current.days[0].today.map((r) => r.id)).toEqual([habitTaskId(HABIT.id, TODAY)]);
  });

  it("ending it sets today's untouched day Task aside; restarting brings it back", () => {
    const endedNow = { ...HABIT, ...withHabitEndDate(HABIT, "2026-05-19", TODAY) };
    const aside = habitTodayTaskAfterEdit(HABIT, endedNow, dayTask(TODAY), TODAY, 5);
    expect(aside?.status).toBe("archived");
    const back = habitTodayTaskAfterEdit(endedNow, HABIT, aside ?? undefined, TODAY, 6);
    expect(back?.status).toBe("queued");
  });

  it("leaves a ticked day Task alone when it ends", () => {
    const endedNow = { ...HABIT, endDate: "2026-05-19" };
    expect(habitTodayTaskAfterEdit(HABIT, endedNow, met(TODAY), TODAY, 5)).toBeNull();
  });
});
