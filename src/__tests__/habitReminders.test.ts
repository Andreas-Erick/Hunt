// @vitest-environment node
// Habit reminders (shared core): a Habit's reminder times are due only on its scheduled days
// whose Outcome is still Open. Both apps plan their notifications from dueReminders.
import { describe, expect, it } from "vitest";
import { dueReminders } from "@/mobile/huntCore";
import type { Habit, Task } from "@/lib/domainTypes";

const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
// 2026-11-25 is a Wednesday.
const WED = "2026-11-25";

function habit(overrides: Partial<Habit> = {}): Habit {
  return {
    id: "hab-1",
    title: "Read",
    notes: "",
    questId: null,
    rank: 1000,
    createdAt: at(1, 8),
    reminderTimes: ["20:00"],
    ...overrides,
  };
}

function dayTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `habit:hab-1:${WED}`,
    title: "Read",
    notes: "",
    questId: null,
    status: "queued",
    rank: 1000,
    accumulatedSeconds: 0,
    scheduledDate: WED,
    habitId: "hab-1",
    createdAt: at(25, 0),
    ...overrides,
  };
}

const wednesday = { from: at(25, 0), to: at(26, 0) };

describe("dueReminders: Habit reminders", () => {
  it("is due at each reminder time of an Open scheduled day", () => {
    const due = dueReminders(
      { tasks: [dayTask()], habits: [habit({ reminderTimes: ["07:30", "20:00"] })] },
      wednesday
    );
    expect(due).toEqual([
      {
        kind: "habit",
        key: "habit:hab-1:2026-11-25T07:30",
        itemId: "hab-1",
        title: "Read",
        dateKey: WED,
        time: "07:30",
        fireAt: at(25, 7, 30),
      },
      {
        kind: "habit",
        key: "habit:hab-1:2026-11-25T20:00",
        itemId: "hab-1",
        title: "Read",
        dateKey: WED,
        time: "20:00",
        fireAt: at(25, 20),
      },
    ]);
  });

  it("is due on a day whose day Task is not materialized yet (still Open), and one in Focus", () => {
    expect(dueReminders({ tasks: [], habits: [habit()] }, wednesday)).toHaveLength(1);
    expect(
      dueReminders({ tasks: [dayTask({ status: "active" })], habits: [habit()] }, wednesday)
    ).toHaveLength(1);
  });

  it("stays quiet on a Met day, including one ticked after midnight", () => {
    const met = dayTask({ status: "completed", completedAt: at(25, 19) });
    expect(dueReminders({ tasks: [met], habits: [habit()] }, wednesday)).toEqual([]);
    const late = dayTask({ status: "completed", completedAt: at(26, 0, 30) });
    expect(dueReminders({ tasks: [late], habits: [habit()] }, wednesday)).toEqual([]);
  });

  it("stays quiet on a Skipped day", () => {
    const skipped = dayTask({ skipped: true });
    expect(dueReminders({ tasks: [skipped], habits: [habit()] }, wednesday)).toEqual([]);
  });

  it("stays quiet on a day the Frequency does not ask for", () => {
    const monFri = habit({
      frequencyHistory: [{ effectiveFrom: "2026-11-01", frequency: { type: "weekdays", weekdays: [1, 5] } }],
    });
    expect(dueReminders({ tasks: [], habits: [monFri] }, wednesday)).toEqual([]);
    // Friday 27th is asked for.
    const friday = dueReminders({ tasks: [], habits: [monFri] }, { from: at(25, 0), to: at(28, 0) });
    expect(friday.map((r) => r.dateKey)).toEqual(["2026-11-27"]);
  });

  it("plans each Open scheduled day across a multi-day window, earliest first with Tasks", () => {
    const met = dayTask({ status: "completed", completedAt: at(25, 9) });
    const task: Task = {
      ...dayTask({ id: "tsk-1", title: "Call", habitId: undefined }),
      scheduledDate: "2026-11-26",
      reminderTime: "09:00",
    };
    const due = dueReminders({ tasks: [met, task], habits: [habit()] }, { from: at(25, 0), to: at(27, 0) });
    expect(due.map((r) => r.key)).toEqual(["task:tsk-1:2026-11-26T09:00", "habit:hab-1:2026-11-26T20:00"]);
  });

  it("ignores a Habit with no reminder times, or malformed ones", () => {
    const habits = [
      habit({ id: "none", reminderTimes: undefined }),
      habit({ id: "empty", reminderTimes: [] }),
      habit({ id: "bad", reminderTimes: ["8pm", "24:00"] }),
    ];
    expect(dueReminders({ tasks: [], habits }, wednesday)).toEqual([]);
  });

  it("only reads Habits when given them (old callers pass Tasks only)", () => {
    expect(dueReminders({ tasks: [dayTask()] }, wednesday)).toEqual([]);
  });

  it("judges a day just before midnight by that day: yesterday's evening reminder still fires late", () => {
    const due = dueReminders({ tasks: [], habits: [habit({ reminderTimes: ["23:55"] })] }, {
      from: at(25, 23, 50),
      to: at(26, 0, 5),
    });
    expect(due.map((r) => r.key)).toEqual(["habit:hab-1:2026-11-25T23:55"]);
  });
});

describe("dueReminders: Habit reminders follow the Outcome rule for every Kind and Frequency", () => {
  /** The day Task of `dayKey` (default Wednesday). */
  const taskOn = (dayKey: string, overrides: Partial<Task> = {}) =>
    dayTask({ id: `habit:hab-1:${dayKey}`, scheduledDate: dayKey, ...overrides });
  const ticked = (dayKey: string) => taskOn(dayKey, { status: "completed", completedAt: at(25, 9) });
  const twicePerWeek = habit({
    frequencyHistory: [{ effectiveFrom: "2026-11-01", frequency: { type: "perWeek", times: 2 } }],
  });
  const wedToFri = { from: at(25, 0), to: at(28, 0) };

  it("stays quiet once a Count day reaches its target, and fires while it is partway", () => {
    const count = habit({ kind: "count", target: 3, unit: "glasses" });
    expect(dueReminders({ tasks: [dayTask({ amount: 3 })], habits: [count] }, wednesday)).toEqual([]);
    expect(dueReminders({ tasks: [dayTask({ amount: 2 })], habits: [count] }, wednesday)).toHaveLength(1);
  });

  it("stays quiet for the rest of an N per week Habit Week already Met, even ahead in the plan", () => {
    const met = [ticked("2026-11-23"), ticked("2026-11-24")];
    expect(dueReminders({ tasks: met, habits: [twicePerWeek] }, wedToFri)).toEqual([]);
  });

  it("fires on each day of an N per week Habit Week not yet Met", () => {
    const due = dueReminders({ tasks: [ticked("2026-11-23")], habits: [twicePerWeek] }, wedToFri);
    expect(due.map((r) => r.dateKey)).toEqual([WED, "2026-11-26", "2026-11-27"]);
  });

  it("stays quiet for the rest of a Skipped Habit Week", () => {
    const setAside = taskOn("2026-11-23", { skipped: true });
    expect(dueReminders({ tasks: [setAside], habits: [twicePerWeek] }, wedToFri)).toEqual([]);
  });

  it("stays quiet after an Ended Habit's end date, and inside a restarted Habit's ended span", () => {
    expect(dueReminders({ tasks: [], habits: [habit({ endDate: "2026-11-24" })] }, wedToFri)).toEqual([]);
    const restarted = habit({ endedSpans: [{ from: "2026-11-20", to: "2026-11-26" }] });
    expect(dueReminders({ tasks: [], habits: [restarted] }, wedToFri).map((r) => r.dateKey)).toEqual(["2026-11-27"]);
  });

  it("fires an Avoid Habit's evening check-in while its day is Open, and stays quiet once a Slip ends it", () => {
    const avoid = habit({ kind: "avoid", reminderTimes: ["21:00"] });
    expect(dueReminders({ tasks: [], habits: [avoid] }, wednesday).map((r) => r.key)).toEqual([
      "habit:hab-1:2026-11-25T21:00",
    ]);
    expect(dueReminders({ tasks: [dayTask({ slips: 1 })], habits: [avoid] }, wednesday)).toEqual([]);
    expect(dueReminders({ tasks: [dayTask({ skipped: true })], habits: [avoid] }, wednesday)).toEqual([]);
  });
});
