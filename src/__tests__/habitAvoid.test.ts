// @vitest-environment node
// Avoid Habits (GLOSSARY: Avoid Habit, Slip): the day succeeds unless a Slip is logged. The shared
// rules both apps judge and log through, tested once through HuntCore.
import { describe, expect, it } from "vitest";
import {
  avoidDayLabel,
  buildHabitTaskRow,
  habitDayOutcome,
  habitDaySlips,
  habitKindOf,
  habitTodayTally,
  isOpenTask,
  logHabitSlip,
  summarizeHabitDays,
  undoHabitSlip,
} from "@/mobile/huntCore";
import type { Habit, Task } from "@/lib/domainTypes";

const TODAY = "2026-11-22";
const AT = new Date(2026, 10, 22, 21, 0).getTime();
const NO_ALCOHOL: Habit = {
  id: "hab-dry",
  title: "No alcohol",
  notes: "",
  questId: null,
  rank: 1000,
  createdAt: new Date(2026, 10, 15, 9, 0).getTime(),
  kind: "avoid",
};

const dayTask = (dateKey: string, overrides: Partial<Task> = {}): Task => ({
  ...buildHabitTaskRow(NO_ALCOHOL, dateKey),
  ...overrides,
});
const outcome = (dayKey: string, task: Partial<Task> | undefined, todayKey = TODAY) =>
  habitDayOutcome({
    habit: NO_ALCOHOL,
    dayKey,
    dayTask: task ? { status: "queued", ...task } : undefined,
    todayKey,
  });

describe("Avoid Habit Outcomes", () => {
  it("is a Habit Kind Hunt knows", () => {
    expect(habitKindOf(NO_ALCOHOL)).toBe("avoid");
  });

  it("is Open during the day while no Slip is logged", () => {
    expect(outcome(TODAY, {})).toBe("open");
    expect(outcome(TODAY, undefined)).toBe("open");
  });

  it("becomes Met once the day has ended with no Slip, with no write at midnight", () => {
    const untouched = dayTask("2026-11-21");
    expect(outcome("2026-11-21", untouched, "2026-11-21")).toBe("open");
    expect(outcome("2026-11-21", untouched, TODAY)).toBe("met");
    expect(outcome("2026-11-20", undefined)).toBe("met");
  });

  it("is Missed with one or more Slips, already during the day", () => {
    expect(outcome(TODAY, { slips: 1 })).toBe("missed");
    expect(outcome("2026-11-20", { slips: 3 })).toBe("missed");
  });

  it("is Skipped for a day set aside, Slip or not", () => {
    expect(outcome("2026-11-20", { skipped: true })).toBe("skipped");
    expect(outcome(TODAY, { skipped: true, slips: 1 })).toBe("skipped");
  });

  it("judges by Slips, not by the tick: a day ticked done on an old device is still Open today", () => {
    expect(outcome(TODAY, { status: "completed" })).toBe("open");
    expect(outcome("2026-11-20", { status: "completed", slips: 1 })).toBe("missed");
  });

  it("summarizeHabitDays counts days kept with no rows as a Streak, broken by a Slip", () => {
    const tasks = [dayTask("2026-11-18", { slips: 1 }), dayTask("2026-11-21")];
    const s = summarizeHabitDays(tasks, TODAY, [NO_ALCOHOL]).summaryFor(NO_ALCOHOL.id);
    expect(s.outcomeOn("2026-11-19")).toBe("met");
    expect(s.outcomeOn(TODAY)).toBe("open");
    expect(s.streak).toBe(3); // 19th, 20th, 21st; today Open is passed over
    expect(s.doneToday).toBe(false);
  });

  it("leaves Avoid Habits out of the done-today tally: they ask nothing to be done", () => {
    const check: Habit = { ...NO_ALCOHOL, id: "hab-read", title: "Read", kind: "check" };
    const { summaryFor } = summarizeHabitDays([], TODAY, [NO_ALCOHOL, check]);
    expect(habitTodayTally([NO_ALCOHOL, check], summaryFor, TODAY)).toEqual({ done: 0, asked: 1 });
  });
});

describe("logging and undoing a Slip", () => {
  it("a Slip adds one to the day and stamps it; the day stays a queued day Task", () => {
    const once = logHabitSlip(dayTask(TODAY), AT);
    expect(once).toMatchObject({ slips: 1, status: "queued", updatedAt: AT });
    expect(habitDaySlips(logHabitSlip(once, AT + 1))).toBe(2);
  });

  it("undo takes one Slip back; with none left the day is Open again", () => {
    const twice = dayTask(TODAY, { slips: 2 });
    expect(habitDaySlips(undoHabitSlip(twice, AT))).toBe(1);
    const none = undoHabitSlip(dayTask(TODAY, { slips: 1 }), AT);
    expect(none.slips).toBeUndefined();
    expect(none.updatedAt).toBe(AT);
    expect(outcome(TODAY, none)).toBe("open");
  });

  it("a slipped day is no longer open work: it leaves Today and the Day Widget", () => {
    expect(isOpenTask(dayTask(TODAY), TODAY)).toBe(true);
    expect(isOpenTask(dayTask(TODAY, { slips: 1 }), TODAY)).toBe(false);
  });

  it("labels the day as its row shows it", () => {
    expect(avoidDayLabel(0)).toBe("Kept so far");
    expect(avoidDayLabel(1)).toBe("1 Slip");
    expect(avoidDayLabel(2)).toBe("2 Slips");
  });
});
