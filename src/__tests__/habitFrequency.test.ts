import { describe, expect, it } from "vitest";
import { habitTaskId } from "@/lib/dateUtils";
import type { Habit, HabitFrequency, Task } from "@/lib/domainTypes";
import { summarizeHabitDays } from "@/lib/habitDay";
import {
  habitFrequencyLabel,
  habitFrequencyOn,
  isHabitScheduledOn,
  withHabitFrequency,
} from "@/lib/habitFrequency";
import { habitDayOutcome } from "@/lib/habitOutcome";
import { habitTodayTaskAfterEdit, missingHabitRows } from "@/lib/taskQueue";

// 2026-05-11 is a Monday. Weekdays are 0 (Sunday) to 6 (Saturday).
const TODAY = "2026-05-11";
const MON_WED_FRI: HabitFrequency = { type: "weekdays", weekdays: [1, 3, 5] };
const EVERY_DAY: HabitFrequency = { type: "everyDay" };

function habit(overrides: Partial<Habit> = {}): Habit {
  return { id: "h", title: "Gym", notes: "", questId: null, rank: 1000, createdAt: 1, ...overrides };
}

function dayTask(dateKey: string, overrides: Partial<Task> = {}): Task {
  return {
    id: habitTaskId("h", dateKey),
    title: "Gym",
    notes: "",
    questId: null,
    habitId: "h",
    status: "queued",
    rank: 1000,
    accumulatedSeconds: 0,
    scheduledDate: dateKey,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const ticked = (dateKey: string) => dayTask(dateKey, { status: "completed" });

describe("Frequency (which days a Habit asks for)", () => {
  it("reads an old Habit row without a Frequency as every day", () => {
    expect(habitFrequencyOn({}, TODAY)).toEqual(EVERY_DAY);
    for (const day of ["2026-05-09", "2026-05-10", TODAY]) expect(isHabitScheduledOn({}, day)).toBe(true);
  });

  it("schedules a chosen-weekdays Habit only on those weekdays", () => {
    const h = habit({ frequencyHistory: [{ effectiveFrom: "2026-05-01", frequency: MON_WED_FRI }] });
    const week = ["2026-05-11", "2026-05-12", "2026-05-13", "2026-05-14", "2026-05-15", "2026-05-16", "2026-05-17"];
    expect(week.map((day) => isHabitScheduledOn(h, day))).toEqual([true, false, true, false, true, false, false]);
  });

  it("gives an unscheduled day no Outcome, even when it has a ticked day Task", () => {
    const h = habit({ frequencyHistory: [{ effectiveFrom: "2026-05-01", frequency: MON_WED_FRI }] });
    expect(habitDayOutcome({ habit: h, dayKey: "2026-05-10", dayTask: undefined, todayKey: TODAY })).toBeNull();
    expect(habitDayOutcome({ habit: h, dayKey: "2026-05-09", dayTask: ticked("2026-05-09"), todayKey: TODAY })).toBeNull();
    expect(habitDayOutcome({ habit: h, dayKey: "2026-05-08", dayTask: undefined, todayKey: TODAY })).toBe("missed");
  });

  it("labels each Frequency for the Habit card, Monday first", () => {
    expect(habitFrequencyLabel(EVERY_DAY)).toBe("Every day");
    expect(habitFrequencyLabel({ type: "weekdays", weekdays: [0, 3, 1] })).toBe("Mon, Wed, Sun");
  });
});

describe("Streak over chosen weekdays", () => {
  it("passes over unscheduled days and is ended only by a scheduled day that was Missed", () => {
    const h = habit({ frequencyHistory: [{ effectiveFrom: "2026-04-01", frequency: MON_WED_FRI }] });
    // Mon 4 Missed, Wed 6 and Fri 8 Met, the weekend unscheduled, today (Mon 11) Open.
    const tasks = [dayTask("2026-05-04"), ticked("2026-05-06"), ticked("2026-05-08"), dayTask(TODAY)];
    expect(summarizeHabitDays(tasks, TODAY, [h]).summaryFor("h").streak).toBe(2);
  });

  it("ends the day walk at the day the Habit began, so a Habit with no Missed day still has a Streak", () => {
    const createdAt = new Date(2026, 4, 6, 9).getTime(); // Wed 6 May
    const h = habit({ createdAt, frequencyHistory: [{ effectiveFrom: "2026-05-06", frequency: MON_WED_FRI }] });
    const tasks = [ticked("2026-05-06"), ticked("2026-05-08"), ticked(TODAY)];
    expect(summarizeHabitDays(tasks, TODAY, [h]).summaryFor("h").streak).toBe(3);
    expect(summarizeHabitDays([], TODAY, [habit({ createdAt, frequencyHistory: h.frequencyHistory })]).summaryFor("h").streak).toBe(0);
  });
});

describe("Frequency change applies from today forward", () => {
  it("keeps the Outcomes of earlier days when a daily Habit changes to chosen weekdays", () => {
    const daily = habit();
    const changed = habit({ frequencyHistory: withHabitFrequency(daily, MON_WED_FRI, TODAY) });
    // Sat 9 and Sun 10 were scheduled (every day) and stay Missed and Met.
    expect(habitDayOutcome({ habit: changed, dayKey: "2026-05-09", dayTask: undefined, todayKey: TODAY })).toBe("missed");
    expect(habitDayOutcome({ habit: changed, dayKey: "2026-05-10", dayTask: ticked("2026-05-10"), todayKey: TODAY })).toBe("met");
    // From today on only Mon, Wed and Fri count.
    expect(isHabitScheduledOn(changed, TODAY)).toBe(true);
    expect(isHabitScheduledOn(changed, "2026-05-12")).toBe(false);
    expect(isHabitScheduledOn(changed, "2026-05-16")).toBe(false);
    // The Streak still counts the Met Sunday before the change.
    const tasks = [ticked("2026-05-08"), dayTask("2026-05-09"), ticked("2026-05-10"), dayTask(TODAY)];
    expect(summarizeHabitDays(tasks, TODAY, [changed]).summaryFor("h").streak).toBe(1);
  });

  it("replaces a change made earlier the same day, and adds nothing when the Frequency is unchanged", () => {
    const once = habit({ frequencyHistory: withHabitFrequency(habit(), MON_WED_FRI, TODAY) });
    const twice = withHabitFrequency(once, { type: "weekdays", weekdays: [2] }, TODAY);
    expect(twice).toEqual([{ effectiveFrom: TODAY, frequency: { type: "weekdays", weekdays: [2] } }]);
    expect(withHabitFrequency(once, EVERY_DAY, TODAY)).toEqual([]);
    expect(withHabitFrequency(habit(), EVERY_DAY, TODAY)).toEqual([]);
    const earlier = habit({ frequencyHistory: [{ effectiveFrom: "2026-05-01", frequency: MON_WED_FRI }] });
    expect(withHabitFrequency(earlier, { type: "weekdays", weekdays: [5, 1, 3] }, TODAY)).toEqual(earlier.frequencyHistory);
  });

  it("sets aside today's untouched day Task when today is no longer scheduled, and brings it back", () => {
    const now = 5000;
    const tuesday = "2026-05-12";
    const daily = habit();
    const weekdays = habit({ frequencyHistory: withHabitFrequency(daily, MON_WED_FRI, tuesday) });
    const setAside = habitTodayTaskAfterEdit(daily, weekdays, dayTask(tuesday), tuesday, now);
    expect(setAside).toMatchObject({ status: "archived", updatedAt: now });

    const dailyAgain = habit({ frequencyHistory: withHabitFrequency(weekdays, EVERY_DAY, tuesday) });
    expect(habitTodayTaskAfterEdit(weekdays, dailyAgain, setAside ?? undefined, tuesday, now + 1)).toMatchObject({
      status: "queued",
      updatedAt: now + 1,
    });
    expect(habitTodayTaskAfterEdit(weekdays, dailyAgain, undefined, tuesday, now)).toMatchObject({
      id: habitTaskId("h", tuesday),
      status: "queued",
    });
  });

  it("leaves a day Task that was already ticked or focused alone, and builds none without a Frequency change", () => {
    const tuesday = "2026-05-12";
    const daily = habit();
    const weekdays = habit({ frequencyHistory: withHabitFrequency(daily, MON_WED_FRI, tuesday) });
    const after = (task: Task | undefined) => habitTodayTaskAfterEdit(daily, weekdays, task, tuesday, 5000);
    expect(after(ticked(tuesday))).toBeNull();
    expect(after(dayTask(tuesday, { accumulatedSeconds: 60 }))).toBeNull();
    expect(after(dayTask(tuesday, { status: "active" }))).toBeNull();
    expect(after(undefined)).toBeNull();
    expect(habitTodayTaskAfterEdit(daily, habit({ title: "Gym" }), undefined, tuesday, 5000)).toBeNull();
  });

  it("keeps today's open day Task aligned with an edited title, Quest and unedited notes", () => {
    const before = habit({ notes: "old" });
    const after = habit({ title: "Lift", questId: "q1", notes: "new" });
    expect(habitTodayTaskAfterEdit(before, after, dayTask(TODAY, { notes: "old" }), TODAY, 5000)).toMatchObject({
      title: "Lift",
      questId: "q1",
      notes: "new",
      updatedAt: 5000,
    });
    // Notes edited on the day Task itself are kept; a ticked day Task is history and stays as it was.
    expect(habitTodayTaskAfterEdit(before, after, dayTask(TODAY, { notes: "mine" }), TODAY, 5000)?.notes).toBe("mine");
    expect(habitTodayTaskAfterEdit(before, after, ticked(TODAY), TODAY, 5000)).toBeNull();
    expect(habitTodayTaskAfterEdit(before, before, dayTask(TODAY, { notes: "old" }), TODAY, 5000)).toBeNull();
  });
});

describe("habit day Tasks only for scheduled days", () => {
  it("builds the missing day rows only for Habits scheduled that day", () => {
    const daily = habit({ id: "daily" });
    const weekdays = habit({ id: "wk", frequencyHistory: [{ effectiveFrom: "2026-05-01", frequency: MON_WED_FRI }] });
    const state = { tasks: [], habits: [daily, weekdays], deletedTaskIds: [] };
    expect(missingHabitRows(state, "2026-05-11").map((t) => t.habitId)).toEqual(["daily", "wk"]);
    expect(missingHabitRows(state, "2026-05-12").map((t) => t.habitId)).toEqual(["daily"]);
  });
});
