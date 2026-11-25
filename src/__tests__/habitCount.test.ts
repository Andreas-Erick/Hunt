// @vitest-environment node
// Count Habits (GLOSSARY: Count Habit): the shared rules both apps log a day's total through.
import { describe, expect, it } from "vitest";
import {
  addHabitDayCount,
  buildHabitTaskRow,
  countProgressLabel,
  habitDayOutcome,
  habitKindOf,
  parseCountAmount,
  setHabitDayAmount,
} from "@/mobile/huntCore";
import type { Habit, Task } from "@/lib/domainTypes";

const DAY = "2026-11-22";
const AT = new Date(2026, 10, 22, 9, 0).getTime();
const JOG: Habit = {
  id: "hab-jog",
  title: "Jog",
  notes: "",
  questId: null,
  rank: 1000,
  createdAt: 100,
  kind: "count",
  target: 3,
  unit: "miles",
};

const dayTask = (overrides: Partial<Task> = {}): Task => ({ ...buildHabitTaskRow(JOG, DAY), ...overrides });

describe("habitKindOf (the migration rule)", () => {
  it("reads an old Habit row without a Kind, or with one this build does not know, as Check", () => {
    expect(habitKindOf({})).toBe("check");
    expect(habitKindOf({ kind: "someday" as never })).toBe("check");
    expect(habitKindOf(JOG)).toBe("count");
  });
});

describe("+1 and exact entry on a Count Habit day", () => {
  it("+1 adds one to the day's total, and the day stays open below the target", () => {
    const once = addHabitDayCount(dayTask(), JOG, AT);
    expect(once).toMatchObject({ amount: 1, status: "queued" });
    expect(once.updatedAt).toBe(AT);
    expect(once.completedAt).toBeUndefined();
    expect(addHabitDayCount(once, JOG, AT + 1).amount).toBe(2);
  });

  it("reaching the target completes the day Task, so every done list agrees with the Outcome", () => {
    const met = addHabitDayCount(dayTask({ amount: 2 }), JOG, AT);
    expect(met).toMatchObject({ amount: 3, status: "completed", completedAt: AT });
    expect(habitDayOutcome({ habit: JOG, dayKey: DAY, dayTask: met, todayKey: DAY })).toBe("met");
  });

  it("going over the target is allowed and keeps the first completion time", () => {
    const over = addHabitDayCount(dayTask({ amount: 3, status: "completed", completedAt: 50 }), JOG, AT);
    expect(over).toMatchObject({ amount: 4, status: "completed", completedAt: 50 });
  });

  it("exact entry sets the total; going below the target reopens the day", () => {
    const met = dayTask({ amount: 3, status: "completed", completedAt: 50 });
    const fixed = setHabitDayAmount(met, JOG, 2.5, AT);
    expect(fixed).toMatchObject({ amount: 2.5, status: "queued" });
    expect("completedAt" in fixed).toBe(false);
  });

  it("never writes a negative or non-finite total, and keeps a Task in Focus in Focus", () => {
    expect(setHabitDayAmount(dayTask(), JOG, -4, AT).amount).toBe(0);
    expect(setHabitDayAmount(dayTask(), JOG, Number.NaN, AT).amount).toBe(0);
    expect(setHabitDayAmount(dayTask({ status: "active" }), JOG, 9, AT).status).toBe("active");
  });

  it("stamps the write newer than the row it replaces (R6), even with a clock behind", () => {
    expect(addHabitDayCount(dayTask({ updatedAt: AT + 5000 }), JOG, AT).updatedAt).toBe(AT + 5001);
  });

  it("leaves the Task it was given untouched", () => {
    const before = dayTask({ amount: 1 });
    const copy = { ...before };
    addHabitDayCount(before, JOG, AT);
    expect(before).toEqual(copy);
  });
});

describe("countProgressLabel and parseCountAmount", () => {
  it("shows the day's total over the target with the unit, going over included", () => {
    expect(countProgressLabel(JOG, 2)).toBe("2 / 3 miles");
    expect(countProgressLabel(JOG, 5)).toBe("5 / 3 miles");
    expect(countProgressLabel({ target: 7 }, 2.5)).toBe("2.5 / 7");
  });

  it("reads a typed amount, with a comma or point for decimals, and refuses anything else", () => {
    expect(parseCountAmount(" 2.5 ")).toBe(2.5);
    expect(parseCountAmount("2,5")).toBe(2.5);
    expect(parseCountAmount("0")).toBe(0);
    expect(parseCountAmount("")).toBeNull();
    expect(parseCountAmount("-1")).toBeNull();
    expect(parseCountAmount("three")).toBeNull();
  });
});
