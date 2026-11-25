// @vitest-environment node
// Notification actions (#32, ADR-0007): which action a reminder's notification offers, and the
// Pending Tick it writes. Done for a Task or a Check Habit's day, +1 for a Count Habit's day,
// nothing to tick for an Avoid Habit's check-in. The shells only show what this answers.
import { describe, expect, it } from "vitest";
import { applyPendingTicks } from "@/mobile/huntCore";
import { reminderAction, reminderActionTick } from "@/lib/reminderActions";
import type { Habit, Task } from "@/lib/domainTypes";
import type { SyncPayload } from "@/lib/syncTypes";

const DAY = "2026-11-25";
const TAP = new Date(2026, 10, 25, 9, 1).getTime();

function habit(id: string, overrides: Partial<Habit> = {}): Habit {
  return { id, title: `Habit ${id}`, notes: "", questId: null, rank: 1000, createdAt: 10, updatedAt: 10, ...overrides } as Habit;
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    notes: "",
    questId: null,
    status: "queued",
    rank: 1000,
    accumulatedSeconds: 0,
    scheduledDate: DAY,
    reminderTime: "09:00",
    createdAt: 10,
    updatedAt: 500,
    ...overrides,
  };
}

const taskReminder = { kind: "task", itemId: "t1", dateKey: DAY };
const habitReminder = (id: string) => ({ kind: "habit", itemId: id, dateKey: DAY });

describe("reminderAction", () => {
  it("offers Done on a Task reminder, ticking that Task", () => {
    expect(reminderAction(taskReminder, [])).toEqual({ tick: "done", taskId: "t1" });
  });

  it("offers Done on a Check Habit reminder, ticking that day's habit Task", () => {
    expect(reminderAction(habitReminder("h1"), [habit("h1")])).toEqual({ tick: "done", taskId: `habtsk-${DAY}-h1` });
  });

  it("offers +1 on a Count Habit reminder", () => {
    const count = habit("h2", { kind: "count", target: 3, unit: "miles" } as Partial<Habit>);
    expect(reminderAction(habitReminder("h2"), [count])).toEqual({ tick: "+1", taskId: `habtsk-${DAY}-h2` });
  });

  it("offers nothing to tick on an Avoid Habit's check-in, a Habit that is gone, or an unknown kind", () => {
    const avoid = habit("h3", { kind: "avoid" } as unknown as Partial<Habit>);
    expect(reminderAction(habitReminder("h3"), [avoid])).toBeNull();
    expect(reminderAction(habitReminder("gone"), [habit("h1")])).toBeNull();
    expect(reminderAction({ kind: "list", itemId: "x", dateKey: DAY }, [])).toBeNull();
  });
});

describe("a notification action, applied as a Pending Tick", () => {
  const state = (tasks: Task[], habits: Habit[]): SyncPayload =>
    ({ tasks, habits, quests: [], timeLogs: [], activeFocus: null } as unknown as SyncPayload);

  it("Done completes the Task once, at the tap time; the same tick read again changes nothing", () => {
    const s = state([task("t1")], []);
    const tick = reminderActionTick(reminderAction(taskReminder, [])!, DAY, TAP);
    expect(tick).toEqual({ taskId: "t1", dateKey: DAY, tickedAt: TAP });
    const once = applyPendingTicks(s, [tick]);
    expect(once.state.tasks[0].status).toBe("completed");
    expect(once.state.tasks[0].completedAt).toBe(TAP);
    const twice = applyPendingTicks(once.state, [tick]);
    expect(twice.state).toBe(once.state);
    expect(twice.skipped.map((x) => x.reason)).toEqual(["already-done"]);
  });

  it("+1 adds one to the Count Habit's day once, creating the day Task Hunt has not made yet", () => {
    const count = habit("h2", { kind: "count", target: 3, unit: "miles", frequencyHistory: undefined } as Partial<Habit>);
    const s = state([], [count]);
    const tick = reminderActionTick(reminderAction(habitReminder("h2"), [count])!, DAY, TAP);
    expect(tick).toEqual({ taskId: `habtsk-${DAY}-h2`, dateKey: DAY, tickedAt: TAP, kind: "+1" });
    const once = applyPendingTicks(s, [tick]);
    expect(once.skipped).toEqual([]);
    expect(once.state.tasks.find((t) => t.id === tick.taskId)?.amount).toBe(1);
    const twice = applyPendingTicks(once.state, [tick]);
    expect(twice.skipped.map((x) => x.reason)).toEqual(["already-counted"]);
    expect(twice.state.tasks.find((t) => t.id === tick.taskId)?.amount).toBe(1);
  });
});
